interface Props {
  sessionName: string;
  compact?: boolean;
}

/**
 * 세션 배지 — 이 탭이 어느 계정(쿠키 묶음)에서 열려 있는지.
 *
 * 기본 세션에는 배지를 붙이지 않는다. 평소에는 세션이 하나뿐이고, 그때 배지는 잡음이다.
 * 이름 있는 세션이 섞이는 순간부터 "이 탭이 어느 계정인지" 가 중요해진다 — 공용 계정으로
 * 열린 탭에서 개인 업무를 하는 사고가 여기서 갈린다.
 */
export function SessionBadge({ sessionName, compact = false }: Props): JSX.Element | null {
  if (sessionName === 'default') return null;

  return (
    <span
      data-session-badge={sessionName}
      title={`세션: ${sessionName}`}
      className={[
        'shrink-0 rounded bg-shell-accent/15 font-medium text-shell-accent',
        compact ? 'px-1 text-[9px]' : 'px-1.5 text-[10px]'
      ].join(' ')}
    >
      {sessionName}
    </span>
  );
}
