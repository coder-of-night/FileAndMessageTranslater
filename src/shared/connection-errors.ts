import type { ConnectionRejection } from './api';

export function connectionRejectionMessage(reason: ConnectionRejection): string {
  switch (reason) {
    case 'declined':
      return '对方拒绝了连接申请。请联系对方，在应用中点击“查看并处理”，核对指纹后选择“接受”，然后重试。';
    case 'already-connected':
      return '双方已有连接，请使用现有会话；如果状态不同步，请双方断开后由一方重新发起。';
    case 'request-pending':
      return '已有连接申请正在等待处理。请对方查看并处理现有申请，或等待申请结束后重试。';
    case 'unknown':
      return '对端拒绝了连接申请，但旧版本未说明原因；可能是对方拒绝，也可能已有连接或待处理申请。请双方查看应用状态后由一方重试。';
  }
}
