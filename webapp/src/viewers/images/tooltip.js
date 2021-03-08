import React, { useCallback, useState, useEffect } from "react";
import axios from 'axios'
import { debounce } from "lodash";

import {
    Tag,
    Classes,
    Icon,
    Tooltip,
} from "@blueprintjs/core";

const margin = {marginLeft: '10px'};
const colorFormat = color => color.toString().padStart('x', 3)
const coordFormat = coord => Math.round(coord).toString().padStart('x', 5)


// TODO
// - unmount: cancel the request
//      if (!!this.state.pixel_cancel_source && !!this.state.pixel_cancel_source.token)
//      this.state.pixel_cancel_source.cancel();
// - if not fast enough: server keep image data (tile?)... (if multiprocess? could fill the server memory)
// - when fractional values, merge... to get closer to the display rgb at low zoom



const ColorTooltip = ({color, x, y, image_url}) => {
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
                    setPixel(result.data)
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
    const type = meta.mode ?? meta.type ?? 'data'
    const color_raw = `${type}(${value.join(', ')})`;
    const color_hex = `${type}(${value.map(v => `0x${v.toString(16)}`).join(', ')})`;

    const hide_diplay = value.length === 3 && value[0] === r && value[1] === g && value[2] === b

    return <span style={margin}>
        <Tag style={{background: color, ...margin}} round></Tag>
        {!!pixel && <>
            <Tooltip>
                <code className={loading ? Classes.TEXT_MUTED: undefined} style={margin}>{color_raw}</code>
                <p><code style={margin}>{color_hex}</code></p>
            </Tooltip>
            {error && <Tooltip>
                <Icon icon="warning-sign" intent="danger"/>
                <p>{JSON.stringify(error)}</p>
            </Tooltip>}
        </>}
        {!hide_diplay && <code style={margin}>{color_diplayed}</code>}
    </span>
}



const CoordTooltip = ({x, y}) => {
    if (x === undefined || x === null || y === undefined || y === null)
        return <span/>
    return <span style={margin}>
        <code>x: {coordFormat(x)}, y: {coordFormat(y)}</code>
    </span>
}



export { ColorTooltip, CoordTooltip };