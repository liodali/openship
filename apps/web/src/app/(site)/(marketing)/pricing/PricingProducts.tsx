"use client";
import { useState, type ReactNode } from "react";

export function PricingProducts({
  cloud,
  infrastructure,
}: {
  cloud: ReactNode;
  infrastructure: ReactNode;
}) {
  const [selected, setSelected] = useState("cloud");
  return (
    <>
      <div className="pp-product-tabs" role="group" aria-label="Hosting options">
        {[
          { id: "cloud", title: "Openship Cloud" },
          { id: "infrastructure", title: "Your infrastructure" },
        ].map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected === option.id}
            onClick={() => setSelected(option.id)}
          >
            {option.title}
          </button>
        ))}
      </div>
      <div hidden={selected !== "cloud"}>{cloud}</div>
      <div hidden={selected !== "infrastructure"}>{infrastructure}</div>
    </>
  );
}
