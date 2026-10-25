// Whether card checkout (Pine Labs) has credentials on this deployment. Kept out
// of pinelabs.ts so the room view can ask without loading the payment toolkit.
export const checkoutConfigured = () =>
  Boolean(process.env.PINE_CLIENT_ID?.trim() && process.env.PINE_CLIENT_SECRET?.trim());
