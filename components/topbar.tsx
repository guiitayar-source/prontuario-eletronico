'use client';
import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { PatientSearchModal } from './patient-search-modal';
import type { Patient } from '@/lib/patient-fields';

export function TopBar({
  onSelectPatient,
  onOpenSearch,
}: {
  onSelectPatient?: (p: Patient) => void;
  onOpenSearch?: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (onOpenSearch) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setModalOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpenSearch]);

  const handleSearch = () => {
    if (onOpenSearch) {
      onOpenSearch();
    } else {
      setModalOpen(true);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          meu prontuário<span>CONSULTÓRIO</span>
        </div>
        <button
          type="button"
          className="search"
          onClick={handleSearch}
          aria-label="Buscar paciente"
        >
          <Search size={16} /> Buscar paciente <kbd>Ctrl K</kbd>
        </button>
        <span className="demo-label">Protótipo · dados fictícios</span>
      </header>
      {!onOpenSearch && onSelectPatient && (
        <PatientSearchModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={onSelectPatient}
        />
      )}
    </>
  );
}

export default TopBar;
