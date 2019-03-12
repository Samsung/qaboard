// https://github.com/picturae/openseadragonrgb/blob/master/src/rgb.js
var OpenSeadragon = require('openseadragon')

function onMouseMove(event) {
    this.onCanvasHover(this.getValueAt(event.position));
}



OpenSeadragon.Viewer.prototype.rgb = function(options) {
    if (!this.rgbInstance || options) {
        options = options || {};
        options.viewer = this;
        this.rgbInstance = new OpenSeadragon.RGB(options);
    }
    return this.rgbInstance;
};


/**
* @class RGB
* @classdesc Allows access to RGB values of pixels
* @memberof OpenSeadragon
* @param {Object} options
*/
OpenSeadragon.RGB = function ( options ) {

    OpenSeadragon.extend( true, this, {
        // internal state properties
        viewer:                  null,
        // options
        onCanvasHover:             null,
    }, options );

    if (this.onCanvasHover) {
        this.tracker = new OpenSeadragon.MouseTracker({
            element:            this.viewer.canvas,
            moveHandler:        OpenSeadragon.delegate( this, onMouseMove ),
        });
    }
};

OpenSeadragon.extend( OpenSeadragon.RGB.prototype, /** @lends OpenSeadragon.RGB.prototype */{
    /**
     * Get RGB values of cancas coordinates
     * @method
     * @param {OpenSeadragon.Point} canvasX the point in canvas coordinate system.
     * @param {Number} canvasX X coordinate in canvas coordinate system.
     * @param {Number} canvasY Y coordinate in canvas coordinate system.
     * @return {Object|false} An object containing r,g,b properties or false if this is not supported.
     */
    getValueAt: function( canvasX, canvasY ) {
        var point = arguments.length === 1 ? canvasX : new OpenSeadragon.Point(canvasX, canvasY);
        var viewer = this.viewer;
        var result = viewer.drawer.getRgbAt(point);
        if (result) {
            var image;
            var imagePoint;
            var size;
            for (var i = 0; i < viewer.world.getItemCount(); i++) {
                image = viewer.world.getItemAt(i);
                size = image.getContentSize();
                if (OpenSeadragon.TiledImage.prototype.viewerElementToImageCoordinates) {
                    imagePoint = image.viewerElementToImageCoordinates(point);
                } else {
                    // older version
                    imagePoint = viewer.viewport.viewerElementToImageCoordinates(point);
                }
                if (imagePoint.x >= 0 && imagePoint.y >= 0 && imagePoint.x <= size.x && imagePoint.y <= size.y) {
                    // point is inside an image
                    result.image = image;
                    result.imageCoordinates = imagePoint;
                    result.viewportCoordinates = point;
                }
            }
        }
        return result;
    },
});

/**
 * Get RGB values of cancas coordinates
 * @method
 * @param {OpenSeadragon.Point} point the point in image coordinate system.
 * @return {Object|false} An object containing r,g,b properties or false if this is not supported.
 */
OpenSeadragon.Drawer.prototype.getRgbAt = function(point) {
    if (!this.useCanvas) {
        return false;
    }
    var ratio = OpenSeadragon.pixelDensityRatio;
    var color = this._getContext()
                    .getImageData(point.x * ratio, point.y * ratio, 1, 1).data; // rgba e [0,255]
    return {
        r: color[0],
        g: color[1],
        b: color[2],
        a: color[3]
    };
};
