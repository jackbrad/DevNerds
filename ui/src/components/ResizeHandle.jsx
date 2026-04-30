import { useCallback, useRef } from 'react';

/**
 * Draggable divider between panels.
 * onDrag receives the delta in pixels as the user drags.
 */
export default function ResizeHandle({ onDrag, vertical = false }) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    lastPos.current = vertical ? e.clientY : e.clientX;
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const pos = vertical ? e.clientY : e.clientX;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      onDrag(delta);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [onDrag, vertical]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`
        shrink-0 bg-board-border hover:bg-accent/40 transition-colors duration-150 relative z-10
        ${vertical
          ? 'h-[5px] cursor-row-resize w-full'
          : 'w-[5px] cursor-col-resize h-full'
        }
      `}
    >
      {/* Wider invisible hit area */}
      <div className={`absolute ${vertical ? '-top-3 -bottom-3 left-0 right-0' : '-left-3 -right-3 top-0 bottom-0'}`} />
    </div>
  );
}
