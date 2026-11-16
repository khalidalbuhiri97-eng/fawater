import React, { createContext, useContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  logout: () => Promise<void>;
  busy: boolean;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  logout: async () => {},
  busy: false,
});

export const AuthProvider = AuthContext.Provider;

export function useAuth() {
  return useContext(AuthContext);
}
