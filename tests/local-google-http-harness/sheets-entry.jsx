// Test-only mounting, not Next hydration/routing. The shipped component is unchanged.
import { createRoot } from 'react-dom/client';
import SheetsClient from '../../app/integrations/google-sheets/SheetsClient';
createRoot(document.getElementById('sheets-root')).render(<SheetsClient />);
