// VIOLATION (no-cross-service): reaches into a peer service's source instead of
// consuming it through its @otondev/sdk interface.
import { betaThing } from '../../beta/src/thing.js';

export const alpha = () => betaThing();
