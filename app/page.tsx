'use client';
import { useState } from 'react';
import Registry, { fetchPatient } from '@/components/patients/registry';
import Consultation from '@/components/consultation';
import Agenda from '@/components/agenda';
import Team from '@/components/team';
import Imports from '@/components/imports';
import Settings from '@/components/settings';
import type { Patient } from '@/lib/patient-fields';
export default function Home() {
  const [appointmentId, setAppointmentId] = useState<string | undefined>();
  const [patient, setPatient] = useState<Patient | null>(null),
    [error, setError] = useState(''),
    [section, setSection] = useState<
      'patients' | 'agenda' | 'team' | 'imports' | 'settings'
    >('patients');
  async function open(id: string, appointment?: string) {
    try {
      setPatient(await fetchPatient(id));
      setAppointmentId(appointment);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      {error && (
        <div role="alert" className="capture-error">
          {error}
        </div>
      )}
      {patient ? (
        <Consultation
          key={patient.id}
          patient={patient}
          appointmentId={appointmentId}
          onHome={() => {
            setPatient(null);
            setSection('patients');
          }}
          onUpdated={setPatient}
          onSelect={(p) => {
            setAppointmentId(undefined);
            setPatient(p);
          }}
          onOpenId={open}
          onAgenda={() => {
            setPatient(null);
            setSection('agenda');
          }}
          onSettings={() => {
            setPatient(null);
            setSection('settings');
          }}
        />
      ) : section === 'settings' ? (
        <Settings
          onPatients={() => setSection('patients')}
          onAgenda={() => setSection('agenda')}
          onTeam={() => setSection('team')}
        />
      ) : section === 'imports' ? (
        <Imports
          onPatients={() => setSection('patients')}
          onAgenda={() => setSection('agenda')}
          onTeam={() => setSection('team')}
          onOpenPatient={open}
          onSettings={() => setSection('settings')}
        />
      ) : section === 'agenda' ? (
        <Agenda
          onPatients={() => setSection('patients')}
          onOpenPatient={open}
          onTeam={() => setSection('team')}
          onSettings={() => setSection('settings')}
        />
      ) : section === 'team' ? (
        <Team
          onPatients={() => setSection('patients')}
          onAgenda={() => setSection('agenda')}
          onSettings={() => setSection('settings')}
        />
      ) : (
        <Registry
          onImports={() => setSection('imports')}
          onOpen={(p) => {
            setAppointmentId(undefined);
            setPatient(p);
          }}
          onAgenda={() => setSection('agenda')}
          onTeam={() => setSection('team')}
          onSettings={() => setSection('settings')}
          onConsultation={() =>
            setError('Selecione um paciente na lista para abrir o prontuário.')
          }
        />
      )}
    </>
  );
}
