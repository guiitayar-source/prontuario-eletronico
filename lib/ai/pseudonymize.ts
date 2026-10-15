// O nome do paciente não vai à IA: sai como marcador e volta no rascunho já no servidor.
export const PATIENT_MARKER = '[PACIENTE]';

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Troca cada ocorrência dos nomes do paciente (sem diferenciar maiúsculas) pelo marcador. */
export function hidePatientNames(
  text: string,
  names: (string | null | undefined)[],
) {
  const unique = [
    ...new Set(
      names
        .map((n) => n?.trim())
        .filter((n): n is string => !!n && n.length >= 3),
    ),
  ]
    // Nomes mais longos primeiro: "Ana Maria Souza" antes de "Ana Maria".
    .sort((a, b) => b.length - a.length);
  if (!text || !unique.length) return text;
  const pattern = new RegExp(unique.map(escape).join('|'), 'giu');
  return text.replace(pattern, PATIENT_MARKER);
}

export function restorePatientName(text: string, displayName: string) {
  return text.replaceAll(PATIENT_MARKER, displayName);
}

/** Nome de arquivo sem o nome original, que muitas vezes traz o do paciente. */
export function neutralFileName(original: string) {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(original)?.[1]?.toLowerCase();
  return ext ? `anexo.${ext}` : 'anexo';
}
