import { useState, useEffect } from "react";
import {
    Tag,
    Popover,
    Icon,
    Button,
    Intent,
    MenuItem,
    Menu,
    Colors,
    Toaster,
} from "@blueprintjs/core";
import copy from 'copy-to-clipboard';

import { output_rois, Crop, fitTo } from "./crops"
import AutoCrops from "./AutoCrops";

const toaster = Toaster.create();
const no_rois = {
    label: "Full Image",
    icon: "media",
    rois: [],
}


let default_roi_type = "Full Image"

// TODO: do it for all viewers at once
//       1. when set type, set for all
//       2. wen trigger find, find for all on view? (or force view) ?
//     make diff faster

const RoiViewer = ({output_new, output_ref, path, viewer, current_roi}) => {
    let [selectable_rois, set_selectable_rois] = useState({"Full Image": no_rois})

    // Sample ROIs for testing
    // output_new.test_input_metadata = {"roi": [
    //     {label: "Edge", x: 0, w: 100, y:0, h:100},
    // ]}

    let [selected_rois, set_selected_rois] = useState(default_roi_type)
    // console.log("selectable_rois[selected_rois]", selectable_rois[selected_rois])
    const selected_rois_effective = !!selectable_rois[selected_rois] ? selected_rois : "Full Image"

    let [selected_roi_idx, set_selected_roi_idx] = useState(0)

    useEffect(() => {
        let new_selectable_rois = JSON.parse(JSON.stringify(selectable_rois))

        const preset_rois = output_rois(output_new)
        if (preset_rois.length > 1) {
            new_selectable_rois["ROI Presets"] = {
                label: "ROI Presets",
                icon: "rectangle",
                rois: preset_rois,
            }
            if (selected_rois === "Full Image") {
                set_selected_rois("ROI Presets")
                const index = 0
                set_selected_roi_idx(index)
                fitTo(preset_rois[index], viewer)
            }
        } else {
            new_selectable_rois["ROI Presets"] = null   
        }

        if (!!output_ref && !output_ref.deleted) {
            new_selectable_rois["Auto ROIs"] = {
                label: "Auto ROIs",
                icon: "delta",
                rois: [],
            }
            // new_selectable_rois["Auto False Colors"] = {
            //     label: "Auto False Colors",
            //     icon: "delta",
            //     rois: [],
            // }
        } else {
            new_selectable_rois["Auto ROIs"] = null
            new_selectable_rois["Auto False Colors"] = null
        }
        set_selectable_rois(new_selectable_rois)
    }, [output_ref, output_new]);


    // console.log("selectable_rois", selectable_rois)
    // console.log("selected_rois", selected_rois)
    // console.log("selected_rois_effective", selected_rois_effective)
    // console.log("selected_roi_idx", selected_roi_idx)
    // console.log("rois", rois)

    const rois = selectable_rois[selected_rois_effective]
    const non_default_rois = rois.label !== no_rois.label
    return <><Popover
            interactionKind="hover">
        <Tag
            minimal
            interactive
            icon='area-of-interest'
            intent={non_default_rois ? "primary" : undefined}
            style={{marginBottom: "5px", marginRight: "15px"}}
        >
            View {non_default_rois ? <strong>{selected_rois_effective}</strong> : <span>ROIs</span>}
        </Tag>
        <Menu>
            {Object.values(selectable_rois).filter(_ => _ !== null).map( rois => <MenuItem
                  icon={rois.label === selected_rois_effective ? "tick" : "blank"}
                  label={rois.label.includes("Auto") ? <Icon style={{color: Colors.GOLD4}} icon="clean"/> : undefined}
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
                    copy(to_clipboard)
                    toaster.show({ message: "Copied!", intent: Intent.SUCCESS, timeout: 3000 });          
                }}
            />
        </Menu>
    </Popover>
    {rois.rois.length > 1 && <>
            <Tag minimal icon="chevron-left" interactive style={{marginBottom: "5px", marginRight: "5px"}}
                onClick={() => {
                    const index = (selected_roi_idx - 1) % rois.rois.length
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
    {rois.label == "Auto ROIs" && <AutoCrops
        viewer={viewer}
        output_new={output_new}
        output_ref={output_ref}
        path={path}
        rois={rois.rois}
        updateRois={rois => {
            rois.push({label: 'Full Image'})
            set_selectable_rois({
                ...selectable_rois,
                "Auto ROIs": {
                    ...selectable_rois["Auto ROIs"],
                    rois,
                }
            })
            if (rois.length > 0) {
                set_selected_roi_idx(0)
                fitTo(rois[0], viewer)    
            }
        }
    }/>}
    {false && rois.label == "Auto False Colors" && <div>
        Work in Progress!
    </div>}
    {non_default_rois && <div>{rois.rois.map((roi, idx) => {
        return <Crop
            selected={idx==selected_roi_idx}
            key={idx}
            output={output_new}
            path={path}
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