import { useId } from "react";
import "./ritmBackdrop.css";

/** Static decoration only; the application keeps its existing document scroller. */
export function RitmBackdrop() {
  const id = useId().replace(/:/g, "");

  return (
    <div className="ritm-backdrop" aria-hidden="true">
      <svg className="ritm-backdrop-upper" viewBox="0 0 1100 400" fill="none">
        <defs>
          <linearGradient
            id={`${id}-upper`}
            x1="110"
            y1="20"
            x2="870"
            y2="330"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#F7FCFF" stopOpacity=".8" />
            <stop offset=".42" stopColor="#9ABDE8" stopOpacity=".12" />
            <stop offset="1" stopColor="#648EC9" stopOpacity=".32" />
          </linearGradient>
          <linearGradient
            id={`${id}-edge`}
            x1="210"
            y1="10"
            x2="800"
            y2="400"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="white" stopOpacity=".85" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g
          fill={`url(#${id}-upper)`}
          stroke={`url(#${id}-edge)`}
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M130 -70 430 -180 685 -55 385 78Z" />
          <path d="M130 -70 385 78 385 285 130 140Z" />
          <path d="M385 78 685 -55 685 151 385 285Z" />
          <path d="M523 6 853 -137 1103 -6 775 139Z" />
          <path d="M523 6 775 139 775 337 523 200Z" />
          <path d="M775 139 1103 -6 1103 192 775 337Z" />
        </g>
        <path
          d="M130 -70 385 78 685 -55M523 6 775 139 1103 -6"
          stroke="white"
          strokeOpacity=".7"
          strokeWidth="2"
        />
      </svg>

      <svg className="ritm-backdrop-cubes" viewBox="0 0 520 600" fill="none">
        <defs>
          <linearGradient
            id={`${id}-top`}
            x1="0"
            y1="0"
            x2="145"
            y2="80"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#F3FCFF" stopOpacity=".92" />
            <stop offset=".48" stopColor="#D5E8FD" stopOpacity=".66" />
            <stop offset="1" stopColor="#85AFE6" stopOpacity=".52" />
          </linearGradient>
          <linearGradient
            id={`${id}-left`}
            x1="10"
            y1="55"
            x2="90"
            y2="205"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#DDF3FF" stopOpacity=".74" />
            <stop offset=".45" stopColor="#A5C7F1" stopOpacity=".44" />
            <stop offset="1" stopColor="#739CCE" stopOpacity=".56" />
          </linearGradient>
          <linearGradient
            id={`${id}-right`}
            x1="75"
            y1="65"
            x2="152"
            y2="165"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#5B8FCE" stopOpacity=".72" />
            <stop offset=".45" stopColor="#98BDEC" stopOpacity=".32" />
            <stop offset="1" stopColor="#E1F2FF" stopOpacity=".58" />
          </linearGradient>
          <linearGradient
            id={`${id}-rim`}
            x1="15"
            y1="15"
            x2="120"
            y2="205"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="white" stopOpacity=".95" />
            <stop offset=".55" stopColor="#F3FAFF" stopOpacity=".65" />
            <stop offset="1" stopColor="#E0EFFF" stopOpacity=".12" />
          </linearGradient>
          <g
            id={`${id}-cube`}
            stroke={`url(#${id}-rim)`}
            strokeWidth="1.2"
            strokeLinejoin="round"
          >
            <path d="M0 39 75 0 150 39 75 78Z" fill={`url(#${id}-top)`} />
            <path d="M0 39 75 78 75 198 0 159Z" fill={`url(#${id}-left)`} />
            <path
              d="M75 78 150 39 150 159 75 198Z"
              fill={`url(#${id}-right)`}
            />
            <path
              d="M0 39 75 78 150 39M75 78V198"
              stroke="white"
              strokeOpacity=".65"
            />
            <path
              d="m4 42 68 36v111"
              stroke="white"
              strokeOpacity=".28"
              strokeWidth="3"
            />
          </g>
        </defs>
        <ellipse
          cx="201"
          cy="564"
          rx="225"
          ry="27"
          fill="#567DB3"
          opacity=".07"
        />
        <g opacity=".48">
          <use href={`#${id}-cube`} transform="translate(165 244) scale(.82)" />
          <use href={`#${id}-cube`} transform="translate(296 347) scale(.7)" />
        </g>
        <use
          href={`#${id}-cube`}
          transform="translate(-41 224) scale(1.2)"
          opacity=".76"
        />
        <use
          href={`#${id}-cube`}
          transform="translate(91 312) scale(1.12)"
          opacity=".87"
        />
        <use
          href={`#${id}-cube`}
          transform="translate(99 169) scale(.83)"
          opacity=".83"
        />
        <use
          href={`#${id}-cube`}
          transform="translate(-64 410) scale(1.32)"
          opacity=".66"
        />
        <use
          href={`#${id}-cube`}
          transform="translate(209 431) scale(.76)"
          opacity=".62"
        />
        <path
          d="M0 533 169 446 354 542 185 629Z"
          fill="#DADCF9"
          fillOpacity=".2"
          stroke="white"
          strokeOpacity=".38"
        />
      </svg>
    </div>
  );
}
