import OpenCC from '../vendor/opencc/full.js';

const toTw = OpenCC.Converter({ from: 'cn', to: 'tw' });

export function toTraditional(text) {
  return toTw(text || '');
}
