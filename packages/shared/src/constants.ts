// 领域常量与校验规则（服务端权威判定使用）

export const LIMITS = {
  coordMin: -50000,
  coordMax: 50000,
  sizeMin: 20,
  sizeMax: 4000,
  canvasIdLen: 64,
  nameLen: 40,
  labelLen: 200,
  textLen: 4000,
} as const;

export const FILL_COLORS = new Set([
  '#fef3c7',
  '#fde68a',
  '#fecaca',
  '#fbcfe8',
  '#ddd6fe',
  '#bfdbfe',
  '#a7f3d0',
  '#e5e7eb',
  '#ffffff',
]);

export const COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

export function colorForSession(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) {
    h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return COLORS[h % COLORS.length];
}
