import { createContext } from "react";

export const RoleInactivityContext = createContext(null);

// Doctor manual logout shares the existing clinic session controller.
export const DoctorSignOutContext = createContext(null);
