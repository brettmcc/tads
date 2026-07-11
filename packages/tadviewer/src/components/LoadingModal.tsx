/*
 * A modal overlay to show the loading indicator
 */
import * as React from "react";
import { Spinner, Intent } from "@blueprintjs/core";
import { INTENT_PRIMARY } from "@blueprintjs/core/lib/esm/common/classes";

export function LoadingModal() {
  return (
    <div className="loading-modal-overlay">
      <div className="loading-modal-container">
        <Spinner className="loading-spinner" intent={Intent.PRIMARY} />
      </div>
    </div>
  );
}
