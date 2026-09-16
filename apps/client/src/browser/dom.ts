/**
 * 两个调试客户端共用的一点点 DOM 构造工具。
 *
 * 只有「建一个元素」与「建一个按钮」两件事 —— 页面结构本身写在各自的渲染函数里。
 * 抽出来是为了让单人版（`/debug`）与四家同屏版（`/multi`）保持同一套写法，
 * 而不是各写一份略有出入的。
 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { text?: string; className?: string; onClick?: () => void } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  if (options.onClick) node.addEventListener("click", options.onClick);
  if (children.length > 0) node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  return element("button", { text: label, className, onClick });
}
