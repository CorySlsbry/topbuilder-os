import { redirect } from "next/navigation";

// The app IS the jobs screen; unauthenticated visitors bounce to /login there.
export default function HomePage() {
  redirect("/jobs");
}
