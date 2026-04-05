export const WINDOWS_PROMPT_MARKER_PREFIX = '__GYSHELL_PROMPT__::'
export const WINDOWS_POWERSHELL_SIDECAR_BUILD_THRESHOLD = 17763
export const WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX = 'gyshell-winps-'
export const WINDOWS_POWERSHELL_REMOTE_SIDECAR_DIR_NAME = 'GyShell/prompt-markers'
export const WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS = 24 * 60 * 60 * 1000
export const WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX = 'gyshell-request-'
export const WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX = 'gyshell-output-'

export type WindowsCommandTrackingMode = 'shell-integration' | 'windows-powershell-sidecar'

export interface WindowsPromptMarkerState {
  sequence: number
  exitCode?: number
  cwd?: string
  homeDir?: string
  modifiedAtMs?: number
}

export const parseWindowsBuildNumber = (release: string | undefined): number | undefined => {
  const match = String(release || '').match(/^\d+\.\d+\.(\d+)/)
  if (!match) {
    return undefined
  }
  const build = Number.parseInt(match[1], 10)
  return Number.isFinite(build) ? build : undefined
}

export const shouldUseWindowsPowerShellSidecar = (options: {
  buildNumber?: number
  shell?: string
  trackingChannelAvailable: boolean
}): boolean => {
  if (!options.trackingChannelAvailable) {
    return false
  }
  if (!options.buildNumber || options.buildNumber >= WINDOWS_POWERSHELL_SIDECAR_BUILD_THRESHOLD) {
    return false
  }
  const shell = String(options.shell || '').trim().toLowerCase()
  return shell.includes('powershell') || shell.includes('pwsh')
}

export const escapePowerShellSingleQuotedString = (value: string): string =>
  value.replace(/'/g, "''")

export const buildWindowsPowerShellEncodedCommand = (options: {
  readyMarker: string
  commandTrackingMode: WindowsCommandTrackingMode
  promptMarkerPath?: string
  commandRequestPath?: string
  commandOutputPath?: string
}): string => {
  const sidecarPromptBody = [
    options.commandRequestPath && options.commandOutputPath
      ? [
          '$__gyshell_request_raw=[IO.File]::ReadAllText($global:__gyshell_request_path,$__gyshell_utf8)',
          "if($__gyshell_request_raw){[IO.File]::WriteAllText($global:__gyshell_request_path,'',$__gyshell_utf8);[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8);try{$__gyshell_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__gyshell_request_raw));$__gyshell_prev_progress=$global:ProgressPreference;$global:ProgressPreference='SilentlyContinue';$__gyshell_capture_path=$global:__gyshell_output_path+'.capture';if(Test-Path -LiteralPath $__gyshell_capture_path){Remove-Item -LiteralPath $__gyshell_capture_path -Force -ErrorAction SilentlyContinue};try{. ([scriptblock]::Create($__gyshell_cmd)) *> $__gyshell_capture_path}finally{$__gyshell_rendered=Get-Content -LiteralPath $__gyshell_capture_path -Raw -ErrorAction SilentlyContinue;if($__gyshell_rendered -ne $null){[IO.File]::WriteAllText($global:__gyshell_output_path,[string]$__gyshell_rendered,$__gyshell_utf8)};if(Test-Path -LiteralPath $__gyshell_capture_path){Remove-Item -LiteralPath $__gyshell_capture_path -Force -ErrorAction SilentlyContinue}};$__gyshell_existing=Get-Content -LiteralPath $global:__gyshell_output_path -Raw -ErrorAction SilentlyContinue;$__gyshell_should_native_fallback=([string]::IsNullOrWhiteSpace([string]$__gyshell_existing)) -and ($__gyshell_cmd -match '\\|') -and ($__gyshell_cmd -notmatch '[\\$;{}()]') -and ($__gyshell_cmd -notmatch '\\b[A-Za-z]+-[A-Za-z]+\\b');if($__gyshell_should_native_fallback){$__gyshell_cmd_file=$global:__gyshell_output_path+'.cmd';[IO.File]::WriteAllText($__gyshell_cmd_file,'@echo off'+[Environment]::NewLine+$__gyshell_cmd+[Environment]::NewLine,$__gyshell_utf8);try{cmd.exe /q /d /s /c $__gyshell_cmd_file *> $__gyshell_capture_path}finally{$__gyshell_fallback=Get-Content -LiteralPath $__gyshell_capture_path -Raw -ErrorAction SilentlyContinue;if($__gyshell_fallback -ne $null){[IO.File]::WriteAllText($global:__gyshell_output_path,[string]$__gyshell_fallback,$__gyshell_utf8)};if(Test-Path -LiteralPath $__gyshell_capture_path){Remove-Item -LiteralPath $__gyshell_capture_path -Force -ErrorAction SilentlyContinue};if(Test-Path -LiteralPath $__gyshell_cmd_file){Remove-Item -LiteralPath $__gyshell_cmd_file -Force -ErrorAction SilentlyContinue}}};$global:ProgressPreference=$__gyshell_prev_progress}catch{$global:ProgressPreference=$__gyshell_prev_progress;$__gyshell_error_text=($_|Out-String);$__gyshell_existing=Get-Content -LiteralPath $global:__gyshell_output_path -Raw -ErrorAction SilentlyContinue;[IO.File]::WriteAllText($global:__gyshell_output_path,([string]$__gyshell_existing)+$__gyshell_error_text,$__gyshell_utf8)}}",
        ].join(';')
      : '',
    "$__ok=$?;$__native=$LASTEXITCODE;$__error_count=@($Error).Count;$__has_new_error=($__error_count -gt 0) -and (($__error_count -ne [int]$global:__gyshell_last_error_count) -or ($Error[0] -ne $global:__gyshell_last_error_ref));$__ec=if($__ok){0}elseif($__has_new_error){1}elseif($__native -is [int] -and $__native -ne 0){$__native}else{1};$global:__gyshell_last_error_count=$__error_count;$global:__gyshell_last_error_ref=if($__error_count -gt 0){$Error[0]}else{$null};$global:__gyshell_prompt_seq=[int]$global:__gyshell_prompt_seq+1;$__cwd_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path));$__home_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME));$__line='__GYSHELL_PROMPT__::seq='+$global:__gyshell_prompt_seq+';ec='+$__ec+';cwd_b64='+$__cwd_b64+';home_b64='+$__home_b64;[IO.File]::WriteAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8);'PS '+$PWD.Path+'> '",
  ]
    .filter(Boolean)
    .join(';')
  const psInit =
    options.commandTrackingMode === 'windows-powershell-sidecar' && options.promptMarkerPath
      ? [
          '$__gyshell_utf8=[Text.UTF8Encoding]::new($false)',
          `$global:__gyshell_marker_path='${escapePowerShellSingleQuotedString(options.promptMarkerPath)}'`,
          `$global:__gyshell_request_path='${escapePowerShellSingleQuotedString(options.commandRequestPath || '')}'`,
          `$global:__gyshell_output_path='${escapePowerShellSingleQuotedString(options.commandOutputPath || '')}'`,
          '$global:__gyshell_prompt_seq=0',
          '$global:__gyshell_last_error_count=@($Error).Count',
          '$global:__gyshell_last_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null}',
          '[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($global:__gyshell_marker_path))|Out-Null',
          "[IO.File]::WriteAllText($global:__gyshell_marker_path,'',$__gyshell_utf8)",
          options.commandRequestPath
            ? "[IO.File]::WriteAllText($global:__gyshell_request_path,'',$__gyshell_utf8)"
            : '',
          options.commandOutputPath
            ? "[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)"
            : '',
          `function Global:prompt{${sidecarPromptBody}}`,
          'Clear-Host',
          `Write-Output "${options.readyMarker}"`,
        ]
          .filter(Boolean)
          .join(';')
      : 'function Global:prompt{$ec=if($LASTEXITCODE -ne $null){$LASTEXITCODE}else{if($?){0}else{1}};$cwd_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path));$home_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME));Write-Host "__GYSHELL_TASK_FINISH__::ec=$ec";Write-Host -NoNewline "$([char]27)]1337;gyshell_precmd;ec=$ec;cwd_b64=$cwd_b64;home_b64=$home_b64$([char]7)";"PS $($PWD.Path)> "};Clear-Host;Write-Output "__GYSHELL_READY__"'

  return Buffer.from(psInit, 'utf16le').toString('base64')
}

export const parseWindowsPromptMarkerLine = (
  line: string
): WindowsPromptMarkerState | null => {
  const normalized = String(line || '').replace(/^\ufeff/, '').trim()
  if (!normalized.startsWith(WINDOWS_PROMPT_MARKER_PREFIX)) {
    return null
  }
  const match = normalized.match(
    /^__GYSHELL_PROMPT__::seq=(\d+);ec=(-?\d+);cwd_b64=([^;]+);home_b64=(.+)$/
  )
  if (!match) {
    return null
  }

  const sequence = Number.parseInt(match[1], 10)
  const exitCode = Number.parseInt(match[2], 10)
  if (!Number.isFinite(sequence)) {
    return null
  }

  const decode = (value: string): string | undefined => {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8')
      const sanitized = decoded.replace(/[\u0000-\u001f\u007f]/g, '')
      return sanitized.length > 0 ? sanitized : undefined
    } catch {
      return undefined
    }
  }

  return {
    sequence,
    exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    cwd: decode(match[3]),
    homeDir: decode(match[4])
  }
}
