import { useEffect, useState } from 'react';
import type { AgentStatusView } from '../../../../shared/api';
import type {
  CheckpointView,
  ThreadMessageView,
  ThreadView
} from '../../../../shared/types';
import { useShellStore } from '../../store';
import { PanelFrame } from '../panels/PanelFrame';

/**
 * 스레드 목록 + 대화 보기 + 이어 말하기.
 *
 * 스레드는 메모리에 없고 DB 에 있다. 그래서 앱을 닫았다 켜도 같은 스레드가 그 자리에 있고,
 * 거기에 한 마디 더 보탤 수 있다 — 이것이 M4a 의 핵심 약속이다.
 *
 * `paused` 스레드에는 "이어서" 를 준다. 재개는 마지막 체크포인트로 되돌리는 것이고,
 * 어디로 돌아가는지(체크포인트 이름·진행 커서)를 함께 보여 준다 — 돌아갈 지점을 모르고
 * 누르는 버튼은 무섭다.
 */

const STATUS_LABEL: Record<ThreadView['status'], string> = {
  running: '진행 중',
  paused: '일시정지',
  waiting_approval: '승인 대기',
  waiting_login: '로그인 대기',
  done: '완료',
  failed: '실패'
};

const STATUS_STYLE: Record<ThreadView['status'], string> = {
  running: 'text-shell-accent',
  paused: 'text-amber-500',
  waiting_approval: 'text-amber-500',
  waiting_login: 'text-amber-500',
  done: 'text-shell-muted',
  failed: 'text-red-400'
};

const ROLE_LABEL: Record<ThreadMessageView['role'], string> = {
  human: '사람',
  ai: 'AI',
  system: '시스템',
  tool: '도구'
};

export function ThreadsPanel(): JSX.Element {
  const setPromoteThreadId = useShellStore((state) => state.setPromoteThreadId);
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessageView[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointView[]>([]);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // ── M4b Composer ──
  const [agent, setAgent] = useState<AgentStatusView | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<{ threadId: string; host: string; text: string } | null>(
    null
  );

  const loadThreads = (): void => {
    void window.helm.getThreads().then((list) => {
      setThreads(list);
      setSelected((current) => current ?? list[0]?.id ?? null);
    });
  };

  useEffect(() => {
    const off = window.helm.onThreadsChanged(setThreads);
    loadThreads();
    return off;
  }, []);

  useEffect(() => {
    void window.helm.getAgentStatus().then((status) => {
      setAgent(status);
      setRunning(new Set(status.running));
    });

    const offRunning = window.helm.onAgentRunning((payload) => {
      setRunning((current) => {
        const next = new Set(current);
        if (payload.running) next.add(payload.threadId);
        else next.delete(payload.threadId);
        return next;
      });
    });

    const offProposal = window.helm.onAgentNoteProposal(setProposal);

    return () => {
      offRunning();
      offProposal();
    };
  }, []);

  useEffect(() => {
    if (selected === null) {
      setMessages([]);
      setCheckpoints([]);
      return;
    }

    void window.helm.getThreadMessages(selected).then(setMessages);
    void window.helm.getCheckpoints(selected).then(setCheckpoints);
  }, [selected, threads]);

  const current = threads.find((thread) => thread.id === selected) ?? null;
  const latestCheckpoint = checkpoints[0] ?? null;

  const refresh = (threadId: string): void => {
    void window.helm.getThreadMessages(threadId).then(setMessages);
    void window.helm.getCheckpoints(threadId).then(setCheckpoints);
  };

  /**
   * 보내기 — 가벼운 요청("이 페이지 요약해줘")과 작업 지시("공지 200건 뽑아")가 **같은 입구**를
   * 쓴다(GOAL-M4 IN SCOPE). 둘을 가르는 것은 사람이 아니라 지시문이다.
   *
   * 모델이 설정돼 있지 않으면 예전처럼 스레드에 한 마디 보태는 것으로 떨어진다 —
   * LLM 이 없다고 기록까지 못 남길 이유는 없다.
   */
  const say = (): void => {
    if (selected === null || draft.trim() === '') return;

    const threadId = selected;
    const instruction = draft;

    if (!agent?.available) {
      void window.helm.sayToThread(threadId, instruction).then((added) => {
        if (!added) {
          setMessage('스레드를 찾지 못했습니다');
          return;
        }
        setDraft('');
        setMessage('모델이 설정되지 않아 기록만 남겼습니다(config/llm.json)');
        refresh(threadId);
      });
      return;
    }

    setDraft('');
    setMessage(null);

    void window.helm.runAgent(threadId, instruction).then((outcome) => {
      refresh(threadId);
      if (!outcome) {
        setMessage('에이전트를 시작하지 못했습니다');
        return;
      }

      setMessage(
        outcome.status === 'done'
          ? `완료 · ${outcome.steps}단계 · 모델 ${outcome.llmCalls}회 · 캐시 ${outcome.macroHits}회` +
              (outcome.rows > 0 ? ` · ${outcome.rows}행` : '')
          : `${outcome.status}: ${outcome.summary}`
      );
    });
  };

  const stop = (): void => {
    if (selected === null) return;
    void window.helm.stopAgent(selected);
  };

  return (
    <PanelFrame
      title="작업(스레드)"
      count={threads.length}
      actions={
        <button
          type="button"
          data-thread-new
          className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
          onClick={() => {
            void window.helm.createThread('새 작업').then((created) => {
              if (created) setSelected(created.id);
              loadThreads();
            });
          }}
        >
          새 작업
        </button>
      }
    >
      <div className="flex h-full min-h-0">
        {/* 목록 */}
        <ul
          data-thread-count={threads.length}
          className="min-h-0 w-[260px] shrink-0 overflow-y-auto border-r border-shell-line"
        >
          {threads.length === 0 ? (
            <li className="p-4 text-[13px] text-shell-muted">작업이 없습니다.</li>
          ) : (
            threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  data-thread-id={thread.id}
                  data-thread-status={thread.status}
                  aria-current={thread.id === selected}
                  className={[
                    'w-full px-3 py-2 text-left text-[12px]',
                    thread.id === selected ? 'bg-shell-panel' : 'hover:bg-shell-panel/60'
                  ].join(' ')}
                  onClick={() => setSelected(thread.id)}
                >
                  <span className="block truncate">{thread.title || thread.id}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px]">
                    <span className={STATUS_STYLE[thread.status]}>
                      {STATUS_LABEL[thread.status]}
                    </span>
                    <span className="text-shell-muted">
                      {thread.stepCount}/{thread.stepLimit} 스텝
                    </span>
                    {thread.sessionName !== 'default' ? (
                      <span className="rounded bg-shell-accent/15 px-1 text-shell-accent">
                        {thread.sessionName}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        {/* 대화 */}
        <div className="flex min-h-0 flex-1 flex-col">
          {current ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-shell-line px-4 py-2 text-[12px]">
                <span data-thread-title className="min-w-0 flex-1 truncate font-semibold">
                  {current.title || current.id}
                </span>

                {current.status === 'paused' ? (
                  <button
                    type="button"
                    data-thread-resume
                    className="h-7 rounded bg-shell-accent px-2 text-[12px] text-white hover:opacity-90"
                    onClick={() => {
                      void window.helm.resumeThread(current.id).then((resumed) => {
                        setMessage(
                          resumed
                            ? `체크포인트 ${resumed.checkpointId ?? '-'} 에서 이어갑니다 (탭 ${resumed.tabs.length}개 복원)`
                            : '재개할 지점이 없습니다'
                        );
                        loadThreads();
                      });
                    }}
                  >
                    이어서
                  </button>
                ) : null}

                {/*
                  승격 — 이 스레드의 도구 호출 기록에서 워크플로우 초안을 만든다.
                  초안에는 오라클이 없다. 판정 기준은 사람이 붙여야 한다(M5).
                */}
                <button
                  type="button"
                  data-thread-promote
                  className="h-7 rounded border border-shell-line px-2 text-[12px] hover:bg-shell-panel"
                  onClick={() => {
                    setPromoteThreadId(current.id);
                    void window.helm.openPanel('workflows');
                  }}
                >
                  워크플로우로 승격
                </button>

                {current.status === 'running' || current.status === 'paused' ? (
                  <button
                    type="button"
                    data-thread-stop
                    className="h-7 rounded border border-shell-line px-2 text-[12px] hover:bg-shell-panel"
                    onClick={() => {
                      void window.helm.stopThread(current.id).then(() => {
                        setMessage('여기까지로 표시했습니다. 탭은 사람 소유로 넘어갑니다.');
                        loadThreads();
                      });
                    }}
                  >
                    여기까지
                  </button>
                ) : null}

                <button
                  type="button"
                  data-checkpoint-save
                  title="지금 상태를 복구 지점으로 저장"
                  className="h-7 rounded border border-shell-line px-2 text-[12px] text-shell-muted hover:text-shell-text"
                  onClick={() => {
                    void window.helm.saveCheckpoint(current.id, '수동 저장').then((saved) => {
                      setMessage(saved ? `체크포인트 ${saved.id} 저장` : '저장 실패');
                      void window.helm.getCheckpoints(current.id).then(setCheckpoints);
                    });
                  }}
                >
                  체크포인트
                </button>
              </div>

              {message ? (
                <p
                  data-thread-message
                  className="shrink-0 border-b border-shell-line bg-shell-panel px-4 py-1.5 text-[12px]"
                >
                  {message}
                </p>
              ) : null}

              {latestCheckpoint ? (
                <p
                  data-checkpoint-latest={latestCheckpoint.id}
                  className="shrink-0 border-b border-shell-line px-4 py-1.5 text-[11px] text-shell-muted"
                >
                  최근 복구 지점: {latestCheckpoint.name} · 탭{' '}
                  {latestCheckpoint.payload.tabs.length}개 · 결과{' '}
                  {latestCheckpoint.payload.results.length}행 · 커서{' '}
                  {JSON.stringify(latestCheckpoint.payload.cursor)}
                </p>
              ) : null}

              <ul
                data-message-count={messages.length}
                className="min-h-0 flex-1 divide-y divide-shell-line overflow-y-auto text-[12px]"
              >
                {messages.map((item) => (
                  <li key={item.id} data-message-seq={item.seq} className="flex gap-2 px-4 py-1.5">
                    <span className="w-10 shrink-0 text-[11px] text-shell-muted">
                      {ROLE_LABEL[item.role]}
                    </span>
                    <span className="min-w-0 flex-1 break-all">
                      {item.role === 'tool' ? (
                        <>
                          <span className="font-medium">{item.tool}</span>{' '}
                          <span className="text-shell-muted">
                            {JSON.stringify(item.args).slice(0, 160)}
                          </span>
                        </>
                      ) : (
                        item.text
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {proposal && proposal.threadId === current.id ? (
                <div
                  data-note-proposal={proposal.host}
                  className="flex shrink-0 items-center gap-2 border-t border-shell-line bg-amber-500/10 px-4 py-2 text-[12px]"
                >
                  <span className="min-w-0 flex-1">
                    <strong>{proposal.host}</strong> 메모로 남길까요? — {proposal.text}
                  </span>
                  <button
                    type="button"
                    data-note-accept
                    className="h-7 rounded bg-shell-accent px-2 text-[11px] text-white hover:opacity-90"
                    onClick={() => {
                      void window.helm.acceptAgentNote(true).then(() => setProposal(null));
                    }}
                  >
                    저장
                  </button>
                  <button
                    type="button"
                    data-note-reject
                    className="h-7 rounded border border-shell-line px-2 text-[11px] hover:bg-shell-panel"
                    onClick={() => {
                      void window.helm.acceptAgentNote(false).then(() => setProposal(null));
                    }}
                  >
                    아니요
                  </button>
                </div>
              ) : null}

              <div className="flex shrink-0 items-center gap-2 border-t border-shell-line px-4 py-2">
                <input
                  data-thread-input
                  placeholder={
                    agent?.available
                      ? '무엇을 할까요 — "이 페이지 요약해줘", "공지 200건 표로 뽑아"'
                      : '이어서 말하기 — 앱을 닫았다 켜도 이 스레드에 남습니다'
                  }
                  className="h-8 min-w-0 flex-1 rounded border border-shell-line bg-shell-panel px-2 text-[12px] outline-none focus:border-shell-accent"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') say();
                  }}
                />
                {running.has(current.id) ? (
                  <button
                    type="button"
                    data-agent-stop
                    className="h-8 rounded border border-shell-line px-3 text-[12px] hover:bg-shell-panel"
                    onClick={stop}
                  >
                    여기까지
                  </button>
                ) : (
                  <button
                    type="button"
                    data-thread-say
                    className="h-8 rounded bg-shell-accent px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-40"
                    disabled={draft.trim() === ''}
                    onClick={say}
                  >
                    보내기
                  </button>
                )}
              </div>

              <p
                data-agent-status={agent?.available ? 'on' : 'off'}
                className="shrink-0 border-t border-shell-line px-4 py-1 text-[11px] text-shell-muted"
              >
                {agent?.available
                  ? `모델 ${agent.model} · 배운 매크로 ${agent.macros}개` +
                    (running.has(current.id) ? ' · 진행 중' : '')
                  : '모델이 설정되지 않았습니다 — config/llm.json'}
              </p>
            </>
          ) : (
            <p className="p-6 text-[13px] text-shell-muted">작업을 고르세요.</p>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}
