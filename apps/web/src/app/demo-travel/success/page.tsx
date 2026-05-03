import Link from "next/link";

export default function DemoTravelSuccessPage() {
  const bookingId = `AEGIS-DEMO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-gray-900 border border-green-900 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-green-950 border border-green-800 flex items-center justify-center text-green-400 text-sm">
              ✓
            </div>
            <h1 className="text-lg font-semibold text-white">Booking Confirmed</h1>
          </div>

          <p className="text-sm text-gray-400">
            The Aegis-controlled flight booking completed. The demo payment method
            was used under the active collar and delegation policy.
            No raw card data was handled by the agent.
          </p>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Booking confirmation</p>
            <p className="text-xs text-white font-mono">{bookingId}</p>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Flight</p>
            <p className="text-xs text-white font-mono">Detroit, MI (DTW) → New York, NY (JFK)</p>
            <p className="text-xs text-gray-400 font-mono">July 15, 2026 · Demo User · $248.00 USD</p>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Payment</p>
            <p className="text-xs text-cyan-400 font-mono">Aegis Demo Card ending 4242</p>
            <p className="text-xs text-gray-600">Tokenized · No raw card data stored or exposed</p>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-md px-3 py-2 space-y-1">
            <p className="text-xs text-gray-500">Execution surface</p>
            <p className="text-xs text-cyan-400 font-mono">aegis_controlled · aegis_playwright</p>
          </div>
        </div>

        <div className="mt-4 text-center">
          <Link
            href="/demo-travel"
            className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
          >
            ← Back to booking
          </Link>
        </div>
      </div>
    </div>
  );
}
