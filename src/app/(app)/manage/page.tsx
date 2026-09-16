import { UniverseManager } from "@/components/universe-manager";
import { AuthGate } from "@/components/auth/auth-gate";

export default function ManagePage() {
  return (
    <AuthGate>
      <UniverseManager />
    </AuthGate>
  );
}
