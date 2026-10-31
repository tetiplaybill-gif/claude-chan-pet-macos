// Original demonstration-state labels for the macOS source edition. MIT.
// These are local visual states, not observations of Claude Chat activity.
export const FACE_LABELS = Array.from({ length: 10 }, (_, index) => `示意表情 ${index + 1}`);
export const STATES = {
  idle: { pose: 'front', texts: [] },
  thinking: { pose: 'front', texts: ['思考动作演示'] },
  working: { pose: 'side', texts: ['工作动作演示'] },
  result: { pose: 'front', texts: ['结果动作演示'] },
  waiting: { pose: 'front', texts: ['等待动作演示'] },
  success: { pose: 'front', texts: ['完成动作演示'] },
  error: { pose: 'front', texts: ['提示动作演示'] },
  sleep: { pose: 'front', texts: ['休息一下'] },
};
export function pickText(state, random = Math.random) {
  const options = STATES[state]?.texts;
  return options?.length ? options[Math.min(options.length - 1, Math.max(0, Math.floor(random() * options.length)))] : null;
}
