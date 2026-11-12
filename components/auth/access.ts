// Papel (owner, doctor, secretary) e clínica de quem entrou, para qualquer tela consultar com
// useAccess(). Preenchido pela tela de entrada (index.tsx) depois de carregar o vínculo.
import { createContext, useContext } from 'react';

export const Access = createContext({ role: '', clinic: '' });
export const useAccess = () => useContext(Access);
