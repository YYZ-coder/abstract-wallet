import type { OperationStatus } from './services';

export function presentOperation(operation: OperationStatus) {
  const reorged = operation.confirmation === 'reorged';
  const succeeded = operation.execution === 'succeeded';
  const reverted = operation.execution === 'reverted';
  const confirmed = operation.confirmation === 'confirmed';
  const view = {
    title: reorged ? '链发生重组，待重新核实' : reverted ? '执行失败' : succeeded ? confirmed ? '交易已确认' : '执行成功，等待确认' : operation.submission === 'unknown' ? '提交结果待核实' : operation.submission === 'rejected' ? '提交被拒绝' : '已受理，等待执行',
    message: reorged ? '链发生重组，原执行结果需要重新核实。请刷新交易状态后再决定下一步。' : succeeded ? confirmed ? '本次转账已确认，可以继续填写下一笔转账。' : '转账已执行，正在等待链上确认。你可以刷新查看进度。' : operation.submission === 'unknown' ? '提交结果尚未核实，请先刷新状态再决定下一步。' : reverted ? '这笔转账执行失败。请检查原因并刷新余额，确认后再重新准备。' : operation.submission === 'rejected' ? '这次提交未被受理。请查看错误信息，重新预览后再确认。' : '交易已提交。点击“刷新交易状态”查看执行结果。',
    execution: reorged ? '待重新核实' : succeeded ? '已执行' : reverted ? '执行失败' : '等待执行',
    confirmation: confirmed ? '已确认' : reorged ? '链重组，待核实' : '等待确认',
  };
  if (!operation.finality || reorged) return view;
  const stage = operation.finality.stage;
  if (stage === 'finalized' && confirmed) {
    view.confirmation = '已最终确认';
    if (succeeded) { view.title = '交易已最终确认'; view.message = '本次转账的父链批次已最终确认，可以继续填写下一笔转账。'; }
    if (reverted) view.title = '执行失败，已最终确认';
  } else if (stage === 'unavailable') {
    view.confirmation = '最终确认暂不可用';
    if (succeeded) view.title = 'L2 已执行，最终确认暂不可用';
    view.message = '已核实执行结果，最终确认查询暂不可用。系统将自动重试，也可手动刷新。';
  } else {
    view.confirmation = stage === 'safe' ? '已安全确认' : '等待最终确认';
    if (succeeded) view.title = stage === 'safe' ? '已安全确认，等待最终确认' : 'L2 已执行，等待最终确认';
    view.message = stage === 'safe' ? '交易已安全确认，正在等待以太坊最终确认。系统会自动更新，无需再次签名。' : '交易已在 L2 执行，正在等待以太坊最终确认。系统会自动更新，无需再次签名。';
  }
  return view;
}
