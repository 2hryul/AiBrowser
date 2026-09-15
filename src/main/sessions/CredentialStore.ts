import { spawn } from 'node:child_process';

/**
 * Windows 자격증명 관리자 — 가져온 비밀번호가 **머무는 곳**.
 *
 * 임포트한 비밀번호를 우리 파일에 두지 않는 이유는 단순하다. 우리 저장소는 우리가 지켜야
 * 하지만, OS 자격증명 관리자는 이미 그 일을 하는 물건이고 사용자의 다른 도구도 그것을 쓴다.
 *
 * ## 의존성을 쓰지 않는다
 *
 * `keytar` 같은 라이브러리를 붙이면 네이티브 빌드와 라이선스 심사가 따라온다
 * (GOAL-M4c STOP CONDITIONS: 허용 목록 밖이면 STOP). 대신 Windows 에 이미 있는
 * `advapi32.dll` 의 `CredWrite` 를 PowerShell 의 P/Invoke 로 부른다 — 새 의존성 0.
 *
 * ## 비밀번호가 지나가는 길
 *
 * **stdin 으로만** 넘긴다. 명령줄 인자에 실으면 프로세스 목록(`tasklist`, WMI)에 그대로
 * 보이고, 그건 평문을 화면에 띄우는 것과 다르지 않다. 파일로도 쓰지 않는다 —
 * "평문을 디스크에 쓰지 않는다"(CONSTRAINTS)가 이 경로의 조건이다.
 */

export interface StoredCredential {
  /** `Helm:<host>` 꼴 — 어느 사이트의 것인지 */
  target: string;
  username: string;
}

export interface CredentialStore {
  /** 하나 저장한다. 비밀번호는 호출 뒤 호출자가 지운다. */
  write(target: string, username: string, secret: string): Promise<void>;
  /** 저장된 것이 있는지 — 값은 돌려주지 않는다. 우리가 다시 읽을 일은 없다. */
  has(target: string): Promise<boolean>;
  /** 되돌리기·테스트 정리용 */
  remove(target: string): Promise<void>;
}

/** `Helm:mail.example.co.kr` — 우리 것임을 접두사로 분명히 한다. */
export function credentialTarget(host: string): string {
  return `Helm:${host}`;
}

const WRITE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HelmCred -Name Native -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}
'@

$secret = [Console]::In.ReadToEnd()
$blob = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret)

try {
  $cred = New-Object HelmCred.Native+CREDENTIAL
  $cred.Type = 1
  $cred.Persist = 2
  $cred.TargetName = $env:HELM_CRED_TARGET
  $cred.UserName = $env:HELM_CRED_USER
  $cred.CredentialBlob = $blob
  $cred.CredentialBlobSize = [System.Text.Encoding]::Unicode.GetByteCount($secret)
  if (-not [HelmCred.Native]::CredWriteW([ref]$cred, 0)) { throw 'CredWrite 실패' }
}
finally {
  # 관리되지 않는 메모리는 0 으로 덮고 푼다.
  [System.Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob)
}
`;

const QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HelmCredQ -Name Native -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
// CharSet 을 빼면 기본이 Ansi 라 W 함수에 잘못된 문자열이 간다 — 삭제가 조용히 실패한다(실측).
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredDeleteW(string target, uint type, uint flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr buffer);
'@

$target = $env:HELM_CRED_TARGET

if ($env:HELM_CRED_OP -eq 'remove') {
  # 결과를 버리지 않는다. [void] 로 삼켰더니 삭제 실패를 성공처럼 보고했다(실측).
  # 없는 항목을 지우는 것은 오류가 아니므로 그 경우만 조용히 넘어간다.
  if ([HelmCredQ.Native]::CredDeleteW($target, 1, 0)) {
    Write-Output 'REMOVED'
  } else {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) { Write-Output 'ABSENT' } else { throw "CredDelete 실패 ($code)" }
  }
}
else {
  $ptr = [IntPtr]::Zero
  # 값은 읽지 않는다 — 있는지만 본다. 다시 꺼낼 일이 없으므로 꺼낼 코드도 두지 않는다.
  if ([HelmCredQ.Native]::CredReadW($target, 1, 0, [ref]$ptr)) {
    [HelmCredQ.Native]::CredFree($ptr)
    Write-Output 'YES'
  } else {
    Write-Output 'NO'
  }
}
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPowerShell(script: string, env: Record<string, string>, stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    /**
     * 스크립트는 `-EncodedCommand` 로, 비밀번호는 stdin 으로.
     *
     * 처음에는 둘 다 stdin 으로 흘려보냈는데 동작하지 않았다(실측) — `-Command -` 는
     * **stdin 전체를 스크립트로** 읽어 버려서 `[Console]::In.ReadToEnd()` 가 빈손이 된다.
     * 스크립트를 인자로 옮기면 stdin 이 비밀번호 전용이 된다. 스크립트는 비밀이 아니므로
     * argv 에 있어도 되고, 임시 파일도 만들지 않는다(평문을 디스크에 쓰지 않는다).
     */
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));

    // stdin 은 비밀번호 전용이다.
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * 실제 Windows 자격증명 관리자.
 *
 * `WRITE_SCRIPT` 는 비밀번호를 `[Console]::In.ReadToEnd()` 로 받는다. 스크립트 자체는
 * `-EncodedCommand` 로 넘어가므로 stdin 은 온전히 비밀번호의 길이다.
 */
export class WindowsCredentialStore implements CredentialStore {
  async write(target: string, username: string, secret: string): Promise<void> {
    const result = await runPowerShell(
      WRITE_SCRIPT,
      { HELM_CRED_TARGET: target, HELM_CRED_USER: username },
      secret
    );

    if (result.code !== 0) {
      // 오류 메시지에 비밀번호가 섞이지 않게 stderr 를 그대로 싣지 않는다.
      throw new Error(`[CredentialStore] 저장 실패 - 대상: ${target} (종료 코드 ${result.code})`);
    }
  }

  async has(target: string): Promise<boolean> {
    const result = await runPowerShell(QUERY_SCRIPT, {
      HELM_CRED_TARGET: target,
      HELM_CRED_OP: 'read'
    });

    return result.stdout.includes('YES');
  }

  async remove(target: string): Promise<void> {
    const result = await runPowerShell(QUERY_SCRIPT, {
      HELM_CRED_TARGET: target,
      HELM_CRED_OP: 'remove'
    });

    // 없는 것을 지우는 것은 성공으로 본다(ABSENT). 그 밖의 실패는 알린다 —
    // 되돌리기가 조용히 실패하면 지웠다고 믿은 자격증명이 남는다.
    if (result.code !== 0) {
      throw new Error(`[CredentialStore] 삭제 실패 - 대상: ${target} (종료 코드 ${result.code})`);
    }
  }
}

/**
 * 메모리 대역 — 테스트가 쓴다.
 *
 * 값을 들고 있지만 **밖으로 꺼내 주지 않는다**(`has` 만 있다). 테스트가 비밀번호를 다시 읽어
 * 비교하고 싶어질 텐데, 그 편의를 열어 두면 제품 코드도 같은 문을 쓰게 된다.
 */
export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, { username: string; length: number }>();

  async write(target: string, username: string, secret: string): Promise<void> {
    this.entries.set(target, { username, length: secret.length });
  }

  async has(target: string): Promise<boolean> {
    return this.entries.has(target);
  }

  async remove(target: string): Promise<void> {
    this.entries.delete(target);
  }

  /** 검증용 — 무엇이 저장됐는지(값 제외) */
  list(): StoredCredential[] {
    return [...this.entries.entries()].map(([target, entry]) => ({
      target,
      username: entry.username
    }));
  }
}
