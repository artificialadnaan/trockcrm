import { useState } from "react";
import { ArrowRight, Camera, Loader2, ShieldCheck, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const featureBullets = [
  { icon: Zap, label: "Bid Board synced in real time" },
  { icon: Camera, label: "Photos straight from the field" },
  { icon: ShieldCheck, label: "DD approvals built in" },
];

export function AuthEntryScreen() {
  const { localLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = new URLSearchParams(window.location.search).get("returnTo");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const result = await localLogin(email, password, returnTo);
      if (!result.mustChangePassword && result.returnTo) {
        window.location.replace(result.returnTo);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="grid min-h-screen bg-slate-50 text-slate-950 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:grid-cols-2">
      <section className="relative flex min-h-[30svh] overflow-hidden bg-slate-950 px-6 py-6 text-white sm:px-10 sm:py-8 md:min-h-screen lg:px-14">
        <div className="absolute inset-x-0 top-0 h-1 bg-brand-red" />
        <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(135deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="relative z-10 flex w-full flex-col">
          <div className="flex items-center gap-4">
            <img className="h-11 w-11 rounded-sm object-contain" src="/logo.png" alt="T Rock" />
            <div>
              <p className="text-lg font-black leading-tight tracking-normal">T Rock Construction CRM</p>
              <p className="text-xs font-bold uppercase tracking-normal text-slate-400">Sales workspace</p>
            </div>
          </div>

          <div className="my-6 max-w-xl sm:my-10 md:my-auto">
            <h1 className="max-w-lg text-3xl font-black leading-[1.05] tracking-normal text-white sm:text-4xl lg:text-5xl">
              Built for how T Rock works.
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-slate-400 sm:mt-6 sm:text-lg">
              Lead to bid to project. One CRM, every office, every rep.
            </p>

            <div className="mt-8 hidden space-y-4 sm:mt-12 sm:block">
              {featureBullets.map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-4 text-sm font-semibold text-slate-300 sm:text-base">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-brand-red shadow-sm">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-auto hidden text-xs font-medium text-slate-400 sm:block">T Rock Construction CRM &middot; &copy; 2026</p>
        </div>
      </section>

      <section className="flex min-h-[70svh] items-center justify-center px-6 py-10 sm:px-10 md:min-h-screen lg:px-14">
        <div className="w-full max-w-md">
          <div className="mb-10">
            <h2 className="text-4xl font-black tracking-normal text-slate-950">Welcome back</h2>
            <p className="mt-3 text-lg text-slate-500">Sign in to your CRM.</p>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-800" htmlFor="email">
                Username/email
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Enter your username"
                autoComplete="username"
                required
                className="h-14 rounded-lg border-slate-200 bg-white px-4 text-base shadow-sm transition focus-visible:ring-2 focus-visible:ring-brand-red/60"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-800" htmlFor="password">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
                className="h-14 rounded-lg border-slate-200 bg-white px-4 text-base shadow-sm transition focus-visible:ring-2 focus-visible:ring-brand-red/60"
              />
            </div>
            {error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
                {error}
              </div>
            ) : null}
            <Button
              className="h-14 w-full rounded-lg bg-brand-red text-base font-black text-white shadow-sm transition hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-brand-red/60 focus-visible:ring-offset-2"
              type="submit"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign In
                  <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
                </>
              )}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-slate-500">
            Forgot password?{" "}
            <a
              className="font-semibold text-brand-red underline underline-offset-4 hover:text-red-800"
              href="mailto:aiqbal@trockgc.com?subject=Password%20reset%20request"
            >
              Contact your administrator
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
