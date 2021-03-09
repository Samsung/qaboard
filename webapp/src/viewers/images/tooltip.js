import React, { useCallback, useState, useEffect } from "react";
import axios from 'axios'
import { debounce } from "lodash";

import {
    Tag,
    Classes,
    Icon,
    Tooltip,
} from "@blueprintjs/core";

// TODO
// - unmount: cancel the request
//      if (!!this.state.pixel_cancel_source && !!this.state.pixel_cancel_source.token)
//      this.state.pixel_cancel_source.cancel();
// - if not fast enough: server keep image data (tile?)... (if multiprocess? could fill the server memory)
// - when fractional values, merge... to get closer to the display rgb at low zoom

const formatting = {
    "dec": {base: 10, prefix: null},
    "hex": {base: 16, prefix: '0x'},
    "bin": {base:  2, prefix: '0b'},
}

const margin = {marginLeft: '10px'};

const Tooltips = ({x, y, has_reference, first_image, image_url_new, image_url_ref, color_new, color_ref}) => {
    const [base, setBase] = useState('dec');
    return <div
                onClick={() => setBase(base === 'dec' ? 'hex' : 'dec')}
            >
                <CoordTooltip x={x} x={y}/>
                <ColorTooltip
                    x={x}
                    y={y}
                    color={first_image === 'new' ? color_new : color_ref}
                    image_url={first_image === 'new' ? image_url_new : image_url_ref}
                    base={base}
                />
                {has_reference && <ColorTooltip
                    x={x}
                    y={y}
                    color={first_image === 'new' ? color_ref : color_new}
                    image_url={first_image === 'new' ? image_url_ref : image_url_new}
                    base={base}
                />}

    </div>
}

const ColorTooltip = ({color, x, y, image_url, base}) => {
    // we try to show the pixel data from the real image
    const [cancel_source, setCancelSource] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [pixel, setPixel] = useState(null)

    const _debounce = useCallback(
        debounce( (_x, _y, _image_url) => {
            // console.log(`current ${x} ${y}`);
            // console.log(`new  ${_x} ${_y}`);
            const fetchData = async () => {
                setLoading(true)
                if (!!cancel_source)
                    cancel_source.cancel();
                const new_cancel_source = axios.CancelToken.source()
                setCancelSource(new_cancel_source)
                try {
                    const params = {
                        x: Math.round(_x),
                        y: Math.round(_y),
                        image_url: _image_url,
                      }
                    const result = await axios.get("/api/v1/output/image/pixel", {params, cancelToken: new_cancel_source.token})
                    const value = Array.isArray(result.data.value) ? result.data.value : [result.data.value]
                    setPixel({
                        value,
                        meta: result.data.meta,
                    })
                    setLoading(false)
                    setError(null)
                } catch(e) {
                    if (!axios.isCancel(e)) {
                        console.log(e)
                        setLoading(false)
                        setError(e)
                    }
                }
            }
            fetchData();
        }, 100),
        []
    );
    useEffect(() => _debounce(x, y, image_url), [x, y, image_url]);

    if (color === undefined || color === null)
        return <span/>
    const { r, g, b } = color;

    const { value=[], meta={} } = pixel || {}
    const type = meta.mode ?? meta.imageType ?? 'data'
    const hide_diplay = value.length === 3 && value[0] === r && value[1] === g && value[2] === b

    const prefix = <span className={Classes.TEXT_MUTED}>{formatting[base].prefix}</span>
    return <span style={margin}>
        <Tag style={{background: color, ...margin}} round></Tag>
        {!!pixel && <>
            <Tooltip>
                <code
                    className={loading ? Classes.TEXT_MUTED: undefined}
                    style={margin}
                >
                    {type}({value.map((v, idx) => <span key={idx}>{prefix}{v.toString(formatting[base].base)}</span>).reduce((acc, x) => acc === null ? [x] : [acc, ', ', x], null)})
                </code>
                <p>Click to toggle hex/decimal numbers</p>
            </Tooltip>
            {error && <Tooltip>
                <Icon icon="warning-sign" intent="danger"/>
                <p>{JSON.stringify(error)}</p>
            </Tooltip>}
        </>}
        {!hide_diplay && <Tooltip>
            <code style={margin}>
                RGB-display({[r, g, b].map((v, idx) => <span key={idx}>{prefix}{v.toString(formatting[base].base)}</span>).reduce((acc, x) => acc === null ? [x] : [acc, ', ', x], null)})
            </code>
            <li>Those values are what's displayed on your screen at this pixel</li>
        </Tooltip>}
    </span>
}


const coordFormat = coord => Math.round(coord).toString().padStart('x', 5)

const CoordTooltip = ({x, y}) => {
    if (x === undefined || x === null || y === undefined || y === null)
        return <span/>
    return <span style={margin}>
        <code>x: {coordFormat(x)}, y: {coordFormat(y)}</code>
    </span>
}



export { Tooltips };