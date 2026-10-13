export const fmtTime = (time: number) => new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export const fmtDay = (time: number) => new Date(time).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
export const formatDuration = (ms: number) => {
  const hours = Math.max(0, Math.ceil(ms / 3_600_000))
  return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时`
}
