// Papéis da clínica. owner (titular) e doctor têm acesso clínico; secretary só agenda, cadastro e
// envio de anexos. Vale para o servidor (assertClinicalRole, em supabase/server.ts) e para as
// telas. A tabela de permissões em components/team.tsx explica isso ao usuário: mantenha as duas
// coisas em sincronia.
export const CLINICAL_ROLES: readonly string[] = ['owner', 'doctor'];

/** Papel com acesso ao prontuário (owner ou doctor). */
export const isClinicalRole = (role: string) => CLINICAL_ROLES.includes(role);
