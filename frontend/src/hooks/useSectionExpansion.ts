import { createContext, useContext } from 'react';

/** A new revision applies a bulk action even after a section was individually toggled. */
export interface SectionExpansion {
  revision: number;
  open?: boolean;
}

export const SectionExpansionContext = createContext<SectionExpansion>({ revision: 0 });
export const useSectionExpansion = () => useContext(SectionExpansionContext);
