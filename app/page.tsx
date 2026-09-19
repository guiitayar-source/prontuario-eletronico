'use client';
import { useState, useEffect } from 'react';
import Registry, { fetchPatient } from '@/components/patients/registry';
import Consultation from '@/components/consultation';
import Agenda from '@/components/agenda';
import Team from '@/components/team';
import Imports from '@/components/imports';
import Settings from '@/components/settings';
import { PatientSearchModal } from '@/components/patient-search-modal';
import type { Patient } from '@/lib/patient-fields';

export default function Home() {
  const [appointmentId, setAppointmentId] = useState<string | undefined>();
  const [patient, setPatient] = useState<Patient | null>(null),
    [error, setError] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [section, setSection] = useState<
      'patients' | 'agenda' | 'team' | 'imports' | 'settings'
    >('patients');

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(''), 4000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  async function open(id: string, appointment?: string) {
    try {
      setPatient(await fetchPatient(id));
      setAppointmentId(appointment);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const selectPatient = (p: Patient) => {
    setAppointmentId(undefined);
    setPatient(p);
    setError('');
  };
  return (
    <>
      {error && (
        <div
          role="alert"
          className="capture-error"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              font: 'inherit',
              fontSize: '20px',
              lineHeight: 1,
              padding: '0 8px',
            }}
            aria-label="Fechar mensagem"
          >
            ×
          </button>
        </div>
      )}
      <PatientSearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(p) => {
          setSearchOpen(false);
          selectPatient(p);
        }}
      />
      {patient ? (
        <Consultation
          key={patient.id}
          patient={patient}
          appointmentId={appointmentId}
          onHome={() => {
            setPatient(null);
            setSection('patients');
            setError('');
          }}
          onUpdated={setPatient}
          onSelect={selectPatient}
          onOpenId={open}
          onAgenda={() => {
            setPatient(null);
            setSection('agenda');
            setError('');
          }}
          onSettings={() => {
            setPatient(null);
            setSection('settings');
            setError('');
          }}
        />
      ) : section === 'settings' ? (
        <Settings
          onPatients={() => {
            setError('');
            setSection('patients');
          }}
          onAgenda={() => {
            setError('');
            setSection('agenda');
          }}
          onTeam={() => {
            setError('');
            setSection('team');
          }}
          onOpenPatient={selectPatient}
        />
      ) : section === 'imports' ? (
        <Imports
          onPatients={() => {
            setError('');
            setSection('patients');
          }}
          onAgenda={() => {
            setError('');
            setSection('agenda');
          }}
          onTeam={() => {
            setError('');
            setSection('team');
          }}
          onOpenPatient={open}
          onSelectPatient={selectPatient}
          onSettings={() => {
            setError('');
            setSection('settings');
          }}
        />
      ) : section === 'agenda' ? (
        <Agenda
          onPatients={() => {
            setError('');
            setSection('patients');
          }}
          onOpenPatient={open}
          onSelectPatient={selectPatient}
          onTeam={() => {
            setError('');
            setSection('team');
          }}
          onSettings={() => {
            setError('');
            setSection('settings');
          }}
        />
      ) : section === 'team' ? (
        <Team
          onPatients={() => {
            setError('');
            setSection('patients');
          }}
          onAgenda={() => {
            setError('');
            setSection('agenda');
          }}
          onSettings={() => {
            setError('');
            setSection('settings');
          }}
          onOpenPatient={selectPatient}
        />
      ) : (
        <Registry
          onImports={() => {
            setError('');
            setSection('imports');
          }}
          onOpen={selectPatient}
          onAgenda={() => {
            setError('');
            setSection('agenda');
          }}
          onTeam={() => {
            setError('');
            setSection('team');
          }}
          onSettings={() => {
            setError('');
            setSection('settings');
          }}
          onConsultation={() => setSearchOpen(true)}
        />
      )}
    </>
  );
}
