import { createContext, useContext } from 'react';

/** Which surface a component is rendered in. The pop-out widget has no drawer or menus of its own. */
export const SurfaceContext = createContext<'main' | 'pip'>('main');
export const useSurface = () => useContext(SurfaceContext);
