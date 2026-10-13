import { useState, useEffect, useEffectEvent } from "react";
import {
    Tag,
    Popover,
    Icon,
    MenuItem,
    Menu,
    Colors,
    Spinner,
    SpinnerSize,
} from "@blueprintjs/core";

import { output_rois, Crop, fitTo } from "./crops"
import AutoCrops from "./AutoCrops";

import { copyWithToast } from "../../utils/clipboard"
const no_rois = {
    label: "Full Image",
    icon: "zoom-out",
    rois: [],
}


let default_roi_type = "Full Image"

// TODO: do it for all viewers at once
//       1. when set type, set for all
//       2. wen trigger find, find for all on view? (or force view) ?
//     make diff faster

// manifest (of output_new) and imageServers: as for the image viewer, so the ROI thumbnails show the same image
// refit: when it changes, the image changed aspect ratio (e.g. a dynamic option picked another file): fit the selected ROI again
const RoiViewer = ({output_new, output_ref, path, manifest, imageServers, viewer, current_roi, fullyLoaded, refit}) => {
    const [selectable_rois, set_selectable_rois] = useState({"Full Image": no_rois})

    // Sample ROIs for testing
    // output_new.test_input_metadata = {"roi": [
    //     {label: "Edge", x: 0, w: 100, y:0, h:100},
    // ]}

    const [selected_rois, set_selected_rois] = useState(default_roi_type)
    // console.log("selectable_rois[selected_rois]", selectable_rois[selected_rois])
    const selected_rois_effective = selectable_rois[selected_rois] ? selected_rois : "Full Image"

    const [selected_roi_idx, set_selected_roi_idx] = useState(0)

    useEffect(() => {
        const preset_rois = output_rois(output_new)
        const has_presets = preset_rois.length > 1
        const has_reference = !!output_ref && !output_ref.deleted
        set_selectable_rois({
            "Full Image": no_rois,
            "ROI Presets": has_presets ? {
                label: "ROI Presets",
                icon: "rectangle",
                rois: preset_rois,
            } : null,
            "Auto ROIs": has_reference ? {
                label: "Auto ROIs",
                icon: "intelligence",
                rois: [],
            } : null,
            ...(has_reference ? {} : { "Auto False Colors": null }),
        })
        if (has_presets && selected_rois === "Full Image") {
            set_selected_rois("ROI Presets")
            const index = 0
            set_selected_roi_idx(index)
            fitTo(preset_rois[index], viewer)
        }
    }, [output_ref, output_new]);


    // only when the image changes, with the ROI selected then
    const fit_selected_roi = useEffectEvent(() => fitTo(selectable_rois[selected_rois_effective].rois[selected_roi_idx] ?? no_rois, viewer))
    useEffect(() => {
        if (refit) fit_selected_roi()
    }, [refit]);


    // console.log("selectable_rois", selectable_rois)
    // console.log("selected_rois", selected_rois)
    // console.log("selected_rois_effective", selected_rois_effective)
    // console.log("selected_roi_idx", selected_roi_idx)
    // console.log("rois", rois)

    const rois = selectable_rois[selected_rois_effective]
    const non_default_rois = rois.label !== no_rois.label
    const popover_content = <Menu>
        {Object.values(selectable_rois).filter(_ => _ !== null).map( rois => <MenuItem
            icon={rois.label === selected_rois_effective ? "tick" : "blank"}
            label={rois.label.includes("Auto") ? <Icon style={{color: Colors.GOLD4}} icon="intelligence"/> : undefined}
            key={rois.label}
            onClick={() => {
                const index = 0
                set_selected_roi_idx(index)
                if (selected_rois_effective !== rois.label) {
                    set_selected_rois(rois.label)
                    const roi = selectable_rois[rois.label].rois[index]
                    default_roi_type = rois.label
                    if (roi) {
                        fitTo(roi, viewer)
                    } else {
                        fitTo({label: "Full Image"}, viewer)
                    }
                } else {
                    set_selected_rois("Full Image")
                    fitTo({label: "Full Image"}, viewer)    
                }
            }}
            text={rois.label}
            shouldDismissPopover={false}
            /> 
        )}
        <MenuItem
            text={"Copy current ROI"}
            icon="duplicate"
            key="copy-paste-roi"
            shouldDismissPopover={false}
            onClick={() => {
                const { x, y, w, h, width, height } = current_roi
                const to_clipboard = `width: ${width}\nheight: ${height}\n- {x: ${Math.round(x)}, y: ${Math.round(y)}, w: ${Math.round(w)}, h: ${Math.round(h)}, label: ""}`;
                copyWithToast(to_clipboard, { what: 'the ROI' })
            }}
        />
    </Menu>
    return <><Popover
                interactionKind="hover"
                content={popover_content}
              >
        <Tag
            minimal
            interactive
            icon='detection'
            intent={non_default_rois ? "primary" : undefined}
            style={{marginBottom: "5px", marginRight: "15px"}}
        >
            View {non_default_rois ? <strong>{selected_rois_effective}</strong> : <span>ROIs</span>}
        </Tag>
    </Popover>
    {!fullyLoaded && <span style={{display: "inline-grid"}}><Spinner size={SpinnerSize.SMALL}/></span>}
    {rois.rois.length > 1 && <>
            <Tag minimal icon="chevron-left" interactive style={{marginBottom: "5px", marginRight: "5px"}}
                onClick={() => {
                    const index = (selected_roi_idx - 1 + rois.rois.length) % rois.rois.length
                    fitTo(rois.rois[index], viewer)
                    set_selected_roi_idx(index)
                }}
            />
            <Tag minimal icon="chevron-right" interactive
                onClick={() => {
                    const index = (selected_roi_idx + 1) % rois.rois.length
                    fitTo(rois.rois[index], viewer)
                    set_selected_roi_idx(index)
                }}
            />
    </>}
    {rois.label === "Auto ROIs" && <AutoCrops
        viewer={viewer}
        output_new={output_new}
        output_ref={output_ref}
        path={path}
        rois={rois.rois}
        updateRois={found_rois => {
            const rois = [...found_rois, {label: 'Full Image'}]
            set_selectable_rois(selectable_rois => ({
                ...selectable_rois,
                "Auto ROIs": {
                    ...selectable_rois["Auto ROIs"],
                    rois,
                }
            }))
            set_selected_roi_idx(0)
            fitTo(rois[0], viewer)
        }
    }/>}
    {non_default_rois && <div>{rois.rois.map((roi, idx) => {
        return <Crop
            selected={idx === selected_roi_idx}
            key={idx}
            output={output_new}
            path={path}
            manifest={manifest}
            imageServers={imageServers}
            roi={roi}
            viewer={viewer}
            onSelect={() => {
                set_selected_roi_idx(idx)
                fitTo(roi, viewer)
            }}
        />
    })}</div>}
    </>
    };


export { RoiViewer };