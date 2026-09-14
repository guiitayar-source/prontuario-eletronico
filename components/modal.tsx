'use client';
import { useEffect, useRef } from 'react';
export function Modal({
  children,
  onClose,
  label,
  className,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal native-modal${className ? ` ${className}` : ''}`}
      aria-label={label}
      onClick={(e) => {
        if (ref.current && e.target === ref.current) {
          onClose();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
