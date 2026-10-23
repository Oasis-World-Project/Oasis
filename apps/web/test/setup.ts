import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 没有实现滚动；页面里的自动滚动在测试中什么也不做
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;
Element.prototype.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
