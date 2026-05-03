"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DemoTravelPage() {
  const router = useRouter();
  const [passengerName, setPassengerName] = useState("Demo User");
  const [from, setFrom] = useState("Detroit, MI (DTW)");
  const [to, setTo] = useState("New York, NY (JFK)");
  const [departureDate, setDepartureDate] = useState("2026-07-15");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    router.push("/demo-travel/success");
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-mono bg-cyan-950 border border-cyan-900 rounded px-3 py-1 mb-4">
            aegis_controlled · sensitivity_level: sensitive
          </div>
          <h1 className="text-xl font-semibold text-white">Book a Flight</h1>
          <p className="text-sm text-gray-500 mt-1">
            Mock travel booking — Aegis-controlled execution with tokenized payment method.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4"
        >
          <div className="space-y-1">
            <label
              htmlFor="passengerName"
              className="block text-xs font-medium text-gray-400"
            >
              Passenger Name
            </label>
            <input
              id="passengerName"
              name="passengerName"
              type="text"
              placeholder="Passenger Name"
              value={passengerName}
              onChange={(e) => setPassengerName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label
                htmlFor="from"
                className="block text-xs font-medium text-gray-400"
              >
                From
              </label>
              <input
                id="from"
                name="from"
                type="text"
                placeholder="From"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="to"
                className="block text-xs font-medium text-gray-400"
              >
                To
              </label>
              <input
                id="to"
                name="to"
                type="text"
                placeholder="To"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="departureDate"
              className="block text-xs font-medium text-gray-400"
            >
              Departure Date
            </label>
            <input
              id="departureDate"
              name="departureDate"
              type="text"
              placeholder="Departure Date"
              value={departureDate}
              onChange={(e) => setDepartureDate(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-400">
              Payment Method
            </label>
            <div className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-300 flex items-center gap-2">
              <span className="text-cyan-500 text-xs">●</span>
              Aegis Demo Card ending 4242
            </div>
            <p className="text-xs text-gray-600">Tokenized · No raw card data stored</p>
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500 py-1 border-t border-gray-800">
            <span>Total Fare</span>
            <span className="text-white font-medium">$248.00 USD</span>
          </div>

          <button
            type="submit"
            data-testid="pay-book-btn"
            className="w-full bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
          >
            Pay &amp; Book
          </button>
        </form>

        <div className="mt-4 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 space-y-1">
          <p className="text-xs text-gray-500 font-medium">Mock workflow</p>
          <p className="text-xs text-gray-600">
            No real money is processed. This page demonstrates Aegis-controlled payment authorization, sensitive event detection, and signed receipt generation.
          </p>
        </div>
      </div>
    </div>
  );
}
