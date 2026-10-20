import { setTimeout as delay } from 'node:timers/promises';

// Waiting is deterministic tool work owned by the official Durable task. A
// restart replays Go's committed admission under the same operation identity.
// No model call or new paid task is used to poll an already accepted result.
export async function awaitBusinessTasks(data, { opsRequest, turnId, signal, canvasId, intervalMs = 1000 }) {
  const result = data?.result;
  const ids = result?.taskIds || (result?.taskId ? [result.taskId] : []);
  if (!ids.length) return data;
  const deadline = Date.now() + 20 * 60 * 1000;
  try { while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const tasks = [];
    for (const taskId of ids) {
      const response = await opsRequest('POST', '/ops/task.get', { params: { taskId } }, signal, turnId);
      tasks.push(response.result);
    }
    const failed = tasks.find(task => ['failed', 'cancelled'].includes(task?.status));
    if (failed) return { ...data, result: { ...result, status: failed.status, tasks, taskError: failed.error || '素材任务未成功，保留原任务，不重复生成' } };
    const ready = tasks.every(task => task?.status === 'succeeded' && task.outputs?.length && task.outputs.every(output => output.resourceId && !output.materializationErrorCode));
    if (ready) {
      let boundRevision;
      if (result.nodeIds?.length) {
        const response = await opsRequest('POST', '/ops/canvas.get', { params: { canvasId } }, signal, turnId);
        const canvas = response.result?.canvas;
        const nodes = canvas?.nodes || [];
        if (!result.nodeIds.every(id => nodes.some(n => n.id === id && ids.includes(n.metadata?.taskId) && n.metadata?.status === 'success' && n.metadata?.storageKey?.startsWith('resource:')))) {
          await delay(intervalMs, undefined, { signal }); continue;
        }
        // Materialization commits after admission. Return the revision read
        // with the bound nodes so the next edit does not start from admission.
        if (Number.isSafeInteger(canvas?.revision) && canvas.revision > 0) boundRevision = canvas.revision;
      }
      const revision = boundRevision === undefined ? {} : { revision: boundRevision };
      return { ...data, ...revision, result: { ...result, ...revision, status: 'succeeded', tasks } };
    }
    await delay(intervalMs, undefined, { signal });
  } } catch (error) {
    if (signal?.aborted) throw error;
    // Admission already succeeded. A failed observation must not hide the
    // original identity and induce a new render or paid submission.
    return { ...data, result: { ...result, status: 'pending', observationFailed: true, note: '原任务已受理，暂时无法读取进度；请按返回的任务ID查询，不要重新提交' } };
  }
  return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
}
