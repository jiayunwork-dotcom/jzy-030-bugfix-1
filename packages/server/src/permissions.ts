// 权限与角色判定
import type { ClientOp, Role } from '@wb/shared';

export interface Principal {
  sessionId: string;
  role: Role;
}

export class RejectError extends Error {
  code: 'forbidden' | 'not_found' | 'bad_request' | 'conflict';
  constructor(code: RejectError['code'], reason: string) {
    super(reason);
    this.code = code;
  }
}

/** 只读成员的任何写操作一律拒绝，并返回可读原因。 */
export function assertCanWrite(who: Principal): void {
  if (who.role === 'viewer') {
    throw new RejectError(
      'forbidden',
      '当前角色为只读，无法编辑画布；请联系房主切换为可编辑。',
    );
  }
}

/** 只有房主可以调整成员角色，且不能对房主执行降级。 */
export function assertCanSetRole(
  who: Principal,
  target: { sessionId: string; role: Role } | undefined,
  nextRole: 'editor' | 'viewer',
): void {
  if (who.role !== 'host') {
    throw new RejectError('forbidden', '只有房主可以切换成员角色。');
  }
  if (!target) {
    throw new RejectError('not_found', '目标成员不存在或已离开画布。');
  }
  if (target.role === 'host') {
    throw new RejectError('forbidden', '房主角色不可被降级。');
  }
  if (target.role === nextRole) {
    throw new RejectError('conflict', `该成员已经是${nextRole === 'viewer' ? '只读' : '可编辑'}角色。`);
  }
}

export function roleLabel(role: Role): string {
  return role === 'host' ? '房主' : role === 'editor' ? '可编辑' : '只读';
}

/** 写操作与角色的总入口校验。 */
export function authorize(
  who: Principal,
  op: ClientOp,
  targetRole: Role | undefined,
): void {
  if (op.t === 'setRole') {
    assertCanSetRole(
      who,
      targetRole ? { sessionId: op.sessionId, role: targetRole } : undefined,
      op.role,
    );
    return;
  }
  assertCanWrite(who);
}
