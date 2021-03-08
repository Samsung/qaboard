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
const colorFormat = color => color.toString().padStart('x', 3)

const ColorTooltip = ({color, x, y, image_url}) => {
    const [base, setBase] = useState('dec');
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
    const color_diplayed = `RGB-display(${colorFormat(r)}, ${colorFormat(g)}, ${colorFormat(b)})`;
    
    const { value=[], meta={} } = pixel || {}
    const type = meta.mode ?? meta.imageType ?? 'data'
    // const color_raw = `${type}(${value.join(', ')})`;
    // const color_hex = `${type}(${value.map(v => `0x${v.toString(16).padStart('x', 3)}`).join(', ')})`;
    const hide_diplay = value.length === 3 && value[0] === r && value[1] === g && value[2] === b

    const prefix = <span className={Classes.TEXT_MUTED}>{formatting[base].prefix}</span>
    return <span style={margin}>
        <Tag style={{background: color, ...margin}} round></Tag>
        {!!pixel && <>
            <Tooltip>
                <code
                    onClick={() => setBase(base === 'dec' ? 'hex' : 'dec')}
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
            <code style={margin}>{color_diplayed}</code>
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



export { ColorTooltip, CoordTooltip };