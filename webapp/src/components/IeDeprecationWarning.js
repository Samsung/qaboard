import React from "react";

import {
  Intent,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

const IeDeprecationWarning = () => {
    const ua = window.navigator.userAgent;
    const is_ie10_or_less = ua.indexOf('MSIE ') > 0;
    const is_ie11 = ua.indexOf('Trident/') > 0;
    const is_ie = is_ie10_or_less || is_ie11;
    if (!is_ie) return <span/>
    return <div style={{
				position: "fixed",
				bottom: "15px",
				right: "15px",
			}}
			>
				<Tooltip>
			        <Tag
			        	icon="warning-sign"
			        	intent={Intent.WARNING}
			        	minimal
			        	large
			        >
			        	This application does not fully support Internet Explorer.
			        </Tag>
                    <span>
                    	Please use a modern browser (eg Chrome/Firefox/Edge/Safari/...)
                    </span>
				</Tooltip>
     </div>
}

export default IeDeprecationWarning;