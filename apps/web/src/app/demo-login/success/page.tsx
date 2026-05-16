import Link from "next/link";

export default function DemoLoginSuccessPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-gray-900 border border-green-900 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-green-950 border border-green-800 flex items-center justify-center text-green-400 text-sm">
              ✓
            </div>
            <h1 className="text-lg font-semibold text-white">Login Successful</h1>
          </div>

          <p className="text-sm text-gray-400">
            The Antigen-controlled login workflow completed. Username and password
            were filled by Antigen under the active collar and delegation policy.
            The agent never received the credentials directly.
          </p>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Execution surface</p>
            <p className="text-xs text-cyan-400 font-mono">aegis_controlled · chrome_extension</p>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Logged in as</p>
            <p className="text-xs text-white font-mono">demo_user</p>
          </div>
        </div>

        <div className="mt-4 text-center">
          <Link
            href="/demo-login"
            className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
          >
            ← Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
