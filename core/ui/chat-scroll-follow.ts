/** Conversation scroll ownership is independent of text/tool execution phases. */
export function createChatScrollFollower(root: Document = document) {
  const win = root.defaultView;
  let started = false;
  let following = false;
  let scroller: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let frame: number | null = null;
  let touchY: number | null = null;
  let lastScrollTop = 0;
  const tolerance = 32;
  const nearBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= tolerance;
  const resize = win && typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => schedule()) : null;
  const discover = () => {
    if (scroller?.isConnected && content?.isConnected) return;
    const previousScroller = scroller;
    const wasFollowing = following;
    resize?.disconnect(); scroller = null; content = null;
    const messages = root.querySelectorAll<HTMLElement>('.ds-message');
    const message = messages[messages.length - 1];
    if (!message || !win) return;
    let child: HTMLElement = message;
    for (let parent = message.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(win.getComputedStyle(parent).overflowY)) {
        scroller = parent; content = child; break;
      }
      child = parent;
    }
    if (!scroller && root.scrollingElement instanceof HTMLElement) {
      scroller = root.scrollingElement; content = root.body;
    }
    if (!scroller) return;
    following = scroller === previousScroller ? wasFollowing : nearBottom(scroller);
    lastScrollTop = scroller.scrollTop;
    resize?.observe(scroller);
    if (content && content !== scroller) resize?.observe(content);
  };
  const flush = () => {
    frame = null;
    if (!started) return;
    discover();
    if (!following || !scroller) return;
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (Math.abs(scroller.scrollTop - bottom) > 1) scroller.scrollTo({ top: bottom, behavior: 'instant' });
  };
  function schedule() {
    if (!started || !win || frame !== null) return;
    frame = win.requestAnimationFrame(flush);
  }
  const suspend = () => {
    following = false;
    lastScrollTop = scroller?.scrollTop ?? 0;
    if (frame !== null) win?.cancelAnimationFrame(frame);
    frame = null;
  };
  const inConversation = (target: EventTarget | null) => target instanceof Node && Boolean(scroller?.contains(target));
  const editable = (target: EventTarget | null) => target instanceof Element
    && Boolean(target.closest('textarea,input,select,[contenteditable="true"]'));
  const onScroll = (event: Event) => {
    discover();
    if (!scroller) return;
    if (event.target !== scroller && !(event.target === root && scroller === root.scrollingElement)) return;
    // The native bottom button and manually scrolling to the bottom both
    // re-arm following. Content growth never clears this remembered intent.
    const movedDown = scroller.scrollTop > lastScrollTop + 1;
    lastScrollTop = scroller.scrollTop;
    if (nearBottom(scroller) && (following || movedDown)) { following = true; schedule(); }
  };
  const onWheel = (event: Event) => {
    if ((event as WheelEvent).deltaY < 0 && inConversation(event.target)) suspend();
  };
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    if (editable(key.target)) return;
    if (!inConversation(key.target) && key.target !== root.body && key.target !== root.documentElement) return;
    if (key.key === 'End') { following = true; schedule(); return; }
    if (['ArrowUp', 'PageUp', 'Home'].includes(key.key) || (key.key === ' ' && key.shiftKey)) suspend();
  };
  const onPointer = (event: Event) => {
    if (event.target === scroller || ((event as PointerEvent).button === 1 && inConversation(event.target))) suspend();
  };
  const onTouchStart = (event: Event) => {
    touchY = inConversation(event.target) ? (event as TouchEvent).touches[0]?.clientY ?? null : null;
  };
  const onTouchMove = (event: Event) => {
    const y = (event as TouchEvent).touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY + 3) suspend();
  };
  const onNavigate = () => { scroller = null; content = null; following = false; schedule(); };
  const listeners: Array<[string, EventListener]> = [
    ['scroll', onScroll], ['wheel', onWheel], ['keydown', onKey], ['pointerdown', onPointer],
    ['touchstart', onTouchStart], ['touchmove', onTouchMove],
  ];
  return {
    start() {
      if (started) return;
      started = true;
      for (const [name, listener] of listeners) root.addEventListener(name, listener, { capture: true, passive: true });
      win?.addEventListener('resize', schedule);
      win?.addEventListener('dpp:navigation', onNavigate);
      discover(); schedule();
    },
    contentChanged() {
      if (following || !scroller?.isConnected || !content?.isConnected) schedule();
    },
    stop() {
      if (!started) return;
      started = false; suspend(); resize?.disconnect();
      for (const [name, listener] of listeners) root.removeEventListener(name, listener, true);
      win?.removeEventListener('resize', schedule);
      win?.removeEventListener('dpp:navigation', onNavigate);
      scroller = null; content = null;
    },
  };
}
