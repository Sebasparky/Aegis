"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Demo credentials — fake, hardcoded for local Aegis-controlled execution demo only.
const DEMO_USERNAME = "demo_user";
const DEMO_PASSWORD = "demo_pass";

export default function DemoLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (username === DEMO_USERNAME && password === DEMO_PASSWORD) {
      router.push("/demo-login/success");
    } else {
      setError("Invalid credentials. This is a demo — try demo_user / demo_pass.");
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-mono bg-cyan-950 border border-cyan-900 rounded px-3 py-1 mb-4">
            aegis_controlled · sensitivity_level: sensitive
          </div>
          <h1 className="text-xl font-semibold text-white">Demo Login</h1>
          <p className="text-sm text-gray-500 mt-1">
            Local test page for Aegis-controlled credential workflow execution.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4"
        >
          <div className="space-y-1">
            <label
              htmlFor="username"
              className="block text-xs font-medium text-gray-400"
            >
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              placeholder="Username"
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="password"
              className="block text-xs font-medium text-gray-400"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-950 border border-red-900 rounded px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
          >
            Sign In
          </button>
        </form>

        <div className="mt-4 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 space-y-1">
          <p className="text-xs text-gray-500 font-medium">Demo credentials</p>
          <p className="text-xs text-gray-400 font-mono">
            username: <span className="text-cyan-400">demo_user</span>
          </p>
          <p className="text-xs text-gray-400 font-mono">
            password: <span className="text-cyan-400">demo_pass</span>
          </p>
          <p className="text-xs text-gray-600 mt-2">
            Agents must request a RouteRun through Aegis — this page is not accessible via{" "}
            <code className="text-gray-500">get_agent_runnable_workflow</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
