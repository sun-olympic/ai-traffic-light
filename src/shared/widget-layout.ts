// 交通灯外壳 62px（灯珠 40 + 水平内边距 20 + 边框 2），外层左右内边距共 8px。
export const COLLAPSED_WINDOW_SIZE = { width: 70, height: 196 } as const;
export const COLLAPSED_WINDOW_WIDTH = COLLAPSED_WINDOW_SIZE.width;
export const COLLAPSED_WINDOW_HEIGHT = COLLAPSED_WINDOW_SIZE.height;

/** Keep the native transparent window tight to visible content when collapsed. */
export function fitWindowHeight(contentHeight: number, minimumHeight: number, maximumHeight = 700): number {
  return Math.min(maximumHeight, Math.max(minimumHeight, Math.ceil(contentHeight + 10)));
}
