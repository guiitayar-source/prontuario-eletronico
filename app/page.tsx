'use client';
import { useState } from 'react';
import Registry, { fetchPatient } from '@/components/patients/registry';
import Consultation from '@/components/consultation';
import Agenda from '@/components/agenda';
import type { Patient } from '@/lib/patient-fields';
export default function Home() {
  const [appointmentId, setAppointmentId] = useState<string | undefined>();
  const [patient, setPatient] = useState<Patient | null>(null),
    [error, setError] = useState(''),
    [section, setSection] = useState<'patients' | 'agenda'>('patients');
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
        />
      ) : section === 'agenda' ? (
        <Agenda
          onPatients={() => setSection('patients')}
          onOpenPatient={open}
        />
      ) : (
        <Registry
          onOpen={(p) => {
            setAppointmentId(undefined);
            setPatient(p);
          }}
          onAgenda={() => setSection('agenda')}
          onConsultation={() =>
            setError('Selecione um paciente na lista para abrir o prontuário.')
          }
        />
      )}
    </>
  );
}
