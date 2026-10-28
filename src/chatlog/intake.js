// 落库

import { isSelfMessage } from './read.js';


export function persistMessage(store, message) {
  const stored = store.append(message);
  return { stored, selfSent: isSelfMessage(stored, store.selfQq) };
}
