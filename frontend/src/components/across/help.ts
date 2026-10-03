import { createContext, useContext } from 'react';

/** Whether explanatory texts are shown everywhere. Off by default; a card can still open its own. */
export const HelpContext = createContext(false);
export const useHelp = (): boolean => useContext(HelpContext);
