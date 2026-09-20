import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatScrollFollower } from '../core/ui/chat-scroll-follow';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function fixture() {
  const scroller = document.createElement('div'); scroller.style.overflowY = 'auto';
  const content = document.createElement('div'); const message = document.createElement('div'); message.className = 'ds-message';
  content.append(message); scroller.append(content); document.body.append(scroller);
  let height = 200; let frame: FrameRequestCallback | undefined;
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height });
  Object.defineProperty(scroller, 'clientHeight', { value: 100 }); scroller.scrollTop = 100;
  const scroll = vi.fn((options: ScrollToOptions) => { scroller.scrollTop = options.top ?? 0; });
  Object.defineProperty(scroller, 'scrollTo', { value: scroll });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frame = undefined; });
  const follower = createChatScrollFollower(); follower.start();
  return { scroller, message, scroll, follower, grow: (value: number) => { height = value; follower.contentChanged(); },
    flush: () => { const callback = frame; frame = undefined; callback?.(0); } };
}

describe('conversation bottom following', () => {
  it('keeps following across large tool-row growth instead of testing the new bottom distance', () => {
    const f = fixture();
    try {
      f.flush(); f.grow(700); f.flush();
      expect(f.scroller.scrollTop).toBe(600);
      f.grow(1000); f.flush(); expect(f.scroller.scrollTop).toBe(900);
    } finally { f.follower.stop(); }
  });
  it('respects upward scrolling and resumes after the native bottom action scrolls down', () => {
    const f = fixture();
    try {
      f.flush(); f.message.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      f.scroller.scrollTop = 20; f.scroller.dispatchEvent(new Event('scroll'));
      f.grow(700); f.flush(); expect(f.scroller.scrollTop).toBe(20);
      f.scroller.scrollTop = 600; f.scroller.dispatchEvent(new Event('scroll'));
      f.grow(1000); f.flush(); expect(f.scroller.scrollTop).toBe(900);
    } finally { f.follower.stop(); }
  });
  it('does not rearm from an already queued bottom scroll event after an upward gesture', () => {
    const f = fixture();
    try {
      f.flush(); f.message.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      f.scroller.dispatchEvent(new Event('scroll'));
      f.grow(700); f.flush(); expect(f.scroller.scrollTop).toBe(100);
    } finally { f.follower.stop(); }
  });
  it('releases the pending frame and input listeners on teardown', () => {
    const f = fixture(); f.flush(); f.grow(700); f.follower.stop(); f.flush();
    f.scroller.dispatchEvent(new Event('scroll')); f.grow(900); f.flush();
    expect(f.scroller.scrollTop).toBe(100); expect(f.scroll).not.toHaveBeenCalled();
  });
});
