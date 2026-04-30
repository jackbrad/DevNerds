import { useState, useEffect } from 'react';

export default function QuipTicker({ quips }) {
  const [index, setIndex] = useState(0);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    if (!quips?.length) return;
    const timer = setInterval(() => {
      setOpacity(0);
      setTimeout(() => {
        setIndex(i => (i + 1) % quips.length);
        setOpacity(1);
      }, 500);
    }, 12000);
    return () => clearInterval(timer);
  }, [quips]);

  if (!quips?.length) return null;

  return (
    <div
      className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-[13px] text-board-subtle italic transition-opacity duration-500"
      style={{ opacity }}
    >
      &ldquo;{quips[index]}&rdquo;
    </div>
  );
}
