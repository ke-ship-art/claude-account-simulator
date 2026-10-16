import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FORMAT = 'claude-local-provider-v1'

export function providerConfigPath() {
  if (process.env.CLAUDE_SIM_CONFIG_PATH) return resolve(process.env.CLAUDE_SIM_CONFIG_PATH)
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'ClaudeAccountSimulator', 'provider-config.dat')
}

async function windowsProtect(value: string, decrypt: boolean): Promise<string> {
  const script = decrypt
    ? `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$value=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($value);$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))`
    : `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$value=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($value);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))`
  return new Promise((done, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = '', error = ''
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.length > 500_000) child.kill() })
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; if (error.length > 10_000) child.kill() })
    child.once('error', fail)
    child.once('close', code => { clearTimeout(timer); code === 0 && output ? done(output.trim()) : fail(new Error(`Windows 凭据保护失败（退出码 ${code}）：${error.slice(0, 500) || '没有输出'}。`)) })
    child.stdin.end(value, 'utf8')
  })
}

export async function readProviderConfig(path = providerConfigPath()): Promise<unknown | undefined> {
  let raw: string
  try { raw = await fs.readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const envelope = JSON.parse(raw)
  if (envelope?.format !== FORMAT || typeof envelope.data !== 'string') throw new Error('本机模型配置格式无效。')
  if (envelope.protection !== (process.platform === 'win32' ? 'windows-dpapi' : 'owner-file')) throw new Error('本机模型配置无法在当前系统用户下读取。')
  const plain = process.platform === 'win32' ? await windowsProtect(envelope.data, true) : envelope.data
  return JSON.parse(plain)
}

export async function writeProviderConfig(value: unknown, path = providerConfigPath()): Promise<void> {
  const plain = JSON.stringify(value)
  const protection = process.platform === 'win32' ? 'windows-dpapi' : 'owner-file'
  const data = process.platform === 'win32' ? await windowsProtect(plain, false) : plain
  const serialized = JSON.stringify({ format: FORMAT, protection, data })
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, path)
    if (process.platform !== 'win32') await fs.chmod(path, 0o600)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
}
