/* eslint-disable */
import * as THREE from 'three';
import { interpolateViridis } from 'd3-scale-chromatic'
import { rgb } from 'd3-color'
/**
 * @author Filipe Caixeta / http://filipecaixeta.com.br
 * @author Mugen87 / https://github.com/Mugen87
 *
 * Description: A THREE loader for PCD ascii and binary files.
 *
 * Limitations: Compressed binary files are not supported.
 *
 */

const PCDLoader = function ( manager ) {

	this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;
	this.littleEndian = true;

};


PCDLoader.prototype = {

	constructor: PCDLoader,
	
	use_intensity: false,
	flip_xy: true,
	mesh_output: false,
	triangle_thresh: 5.0, // maximum distance to connect points

	load: function ( url, onLoad, onProgress, onError ) {

		var scope = this;

		var loader = new THREE.FileLoader( scope.manager );
		loader.setResponseType( 'arraybuffer' );
		loader.load( url, function ( data ) {

			onLoad( scope.parse( data, url ) );

		}, onProgress, onError );

	},

	parse: function ( data, url ) {

		function parseHeader( data ) {

			var PCDheader = {};
			var result1 = data.search( /[\r\n]DATA\s(\S*)\s/i );
			var result2 = /[\r\n]DATA\s(\S*)\s/i.exec( data.substr( result1 - 1 ) );

			PCDheader.data = result2[ 1 ];
			PCDheader.headerLen = result2[ 0 ].length + result1;
			PCDheader.str = data.substr( 0, PCDheader.headerLen );

			// remove comments

			PCDheader.str = PCDheader.str.replace( /#.*/gi, '' );

			// parse

			PCDheader.version = /VERSION (.*)/i.exec( PCDheader.str );
			PCDheader.fields = /FIELDS (.*)/i.exec( PCDheader.str );
			PCDheader.size = /SIZE (.*)/i.exec( PCDheader.str );
			PCDheader.type = /TYPE (.*)/i.exec( PCDheader.str );
			PCDheader.count = /COUNT (.*)/i.exec( PCDheader.str );
			PCDheader.width = /WIDTH (.*)/i.exec( PCDheader.str );
			PCDheader.height = /HEIGHT (.*)/i.exec( PCDheader.str );
			PCDheader.viewpoint = /VIEWPOINT (.*)/i.exec( PCDheader.str );
			PCDheader.points = /POINTS (.*)/i.exec( PCDheader.str );

			// evaluate

			if ( PCDheader.version !== null )
				PCDheader.version = parseFloat( PCDheader.version[ 1 ] );

			if ( PCDheader.fields !== null )
				PCDheader.fields = PCDheader.fields[ 1 ].split( ' ' );

			if ( PCDheader.type !== null )
				PCDheader.type = PCDheader.type[ 1 ].split( ' ' );

			if ( PCDheader.width !== null )
				PCDheader.width = parseInt( PCDheader.width[ 1 ] );

			if ( PCDheader.height !== null )
				PCDheader.height = parseInt( PCDheader.height[ 1 ] );

			if ( PCDheader.viewpoint !== null )
				PCDheader.viewpoint = PCDheader.viewpoint[ 1 ];

			if ( PCDheader.points !== null )
				PCDheader.points = parseInt( PCDheader.points[ 1 ], 10 );

			if ( PCDheader.points === null )
				PCDheader.points = PCDheader.width * PCDheader.height;

			if ( PCDheader.size !== null ) {

				PCDheader.size = PCDheader.size[ 1 ].split( ' ' ).map( function ( x ) {

					return parseInt( x, 10 );

				} );

			}

			if ( PCDheader.count !== null ) {

				PCDheader.count = PCDheader.count[ 1 ].split( ' ' ).map( function ( x ) {

					return parseInt( x, 10 );

				} );

			} else {

				PCDheader.count = [];

				for ( var i = 0, l = PCDheader.fields.length; i < l; i ++ ) {

					PCDheader.count.push( 1 );

				}

			}

			PCDheader.offset = {};

			var sizeSum = 0;

			for ( var i = 0, l = PCDheader.fields.length; i < l; i ++ ) {

				if ( PCDheader.data === 'ascii' ) {

					PCDheader.offset[ PCDheader.fields[ i ] ] = i;

				} else {

					PCDheader.offset[ PCDheader.fields[ i ] ] = sizeSum;
					sizeSum += PCDheader.size[ i ];

				}

			}

			// for binary only

			PCDheader.rowSize = sizeSum;

			return PCDheader;

		}

		var textData = THREE.LoaderUtils.decodeText( data );

		// parse header (always ascii format)

		var PCDheader = parseHeader( textData );

		// parse data

		var position = [];
		var normal = [];
		var color = [];
		var indices = [];

		// ascii

		if ( PCDheader.data === 'ascii' ) {

			var offset = PCDheader.offset;
			var pcdData = textData.substr( PCDheader.headerLen );
			var lines = pcdData.split( '\n' );

			var min_z = 1e10;
			var max_z = 0;
			for ( var i = 0, l = lines.length; i < l; i ++ ) {
				if ( lines[ i ] === '' ) continue;
				var line = lines[ i ].split( ' ' );
				if ( offset.x !== undefined ) {
					var z = parseFloat( line[ offset.z ] );
					if (z > max_z) max_z = z;
					if (z < min_z) min_z = z;
				}
			}

			for ( var i = 0, l = lines.length; i < l; i ++ ) {

				if ( lines[ i ] === '' ) continue;

				var line = lines[ i ].split( ' ' );

				if ( offset.x !== undefined ) {
					var x = parseFloat( line[ offset.x ] );
					var y = parseFloat( line[ offset.y ] );
					var z = parseFloat( line[ offset.z ] );
					position.push(this.flip_xy ? -x : x);
					position.push(this.flip_xy ? -y : y);
					position.push(z);
				}

				if ( offset.rgb !== undefined ) {
					if (this.use_intensity) {
						let parsed_color = parseFloat(line[offset.rgb]) // 0.0 //
						if (parsed_color<0.0)
							parsed_color = 0.0;
						if (parsed_color>1.0)
							parsed_color = 1.0;
						parsed_color = Math.sqrt(parsed_color);
						let z_color = rgb(interpolateViridis(parsed_color))
						color.push(z_color.r / 255.0);
						color.push(z_color.g / 255.0);
						color.push(z_color.b / 255.0);
					}
					else {
						let z_scaled = (z - min_z) / (max_z - min_z);
						let z_color = rgb(interpolateViridis(z_scaled))
						color.push(z_color.r / 255.0);
						color.push(z_color.g / 255.0);
						color.push(z_color.b / 255.0);
					}
					/*if (parsed_color<0.1) {
						
					} else {
						var c = new Float32Array( [parsed_color] );
						var dataview = new DataView( c.buffer, 0 );
						color.push( dataview.getUint8( 0 ) / 255.0 );
						color.push( dataview.getUint8( 1 ) / 255.0 );
						color.push( dataview.getUint8( 2 ) / 255.0 );						
					}
					*/
				}
				

				if ( offset.normal_x !== undefined ) {

					normal.push( parseFloat( line[ offset.normal_x ] ) );
					normal.push( parseFloat( line[ offset.normal_y ] ) );
					normal.push( parseFloat( line[ offset.normal_z ] ) );

				}

			}

		}

		// binary

		if ( PCDheader.data === 'binary_compressed' ) {

			console.error( 'PCDLoader: binary_compressed files are not supported' );
			return;

		}

		if ( PCDheader.data === 'binary' ) {

			var dataview = new DataView( data, PCDheader.headerLen );
			var offset = PCDheader.offset;

			for ( var i = 0, row = 0; i < PCDheader.points; i ++, row += PCDheader.rowSize ) {

				if ( offset.x !== undefined ) {

					position.push( dataview.getFloat32( row + offset.x, this.littleEndian ) );
					position.push( dataview.getFloat32( row + offset.y, this.littleEndian ) );
					position.push( dataview.getFloat32( row + offset.z, this.littleEndian ) );

				}

				if ( offset.rgb !== undefined ) {

					color.push( dataview.getUint8( row + offset.rgb + 0 ) / 255.0 );
					color.push( dataview.getUint8( row + offset.rgb + 1 ) / 255.0 );
					color.push( dataview.getUint8( row + offset.rgb + 2 ) / 255.0 );

				}

				if ( offset.normal_x !== undefined ) {

					normal.push( dataview.getFloat32( row + offset.normal_x, this.littleEndian ) );
					normal.push( dataview.getFloat32( row + offset.normal_y, this.littleEndian ) );
					normal.push( dataview.getFloat32( row + offset.normal_z, this.littleEndian ) );

				}

			}

		}

		// build geometry

		var geometry = new THREE.BufferGeometry();
		
		if ( position.length > 0 ) geometry.addAttribute( 'position', new THREE.Float32BufferAttribute( position, 3 ) );
		if ( normal.length > 0 ) geometry.addAttribute( 'normal', new THREE.Float32BufferAttribute( normal, 3 ) );
		if ( color.length > 0 ) geometry.addAttribute( 'color', new THREE.Float32BufferAttribute( color, 3 ) );
		
		geometry.computeBoundingSphere();

		var w = PCDheader.width;
		var h = PCDheader.height;
		if ( h == null && w == null){
			if (PCDheader.points === 307200){
				h = 480;
				w = 640;
			}
			else if (PCDheader.points === 311696){
				h = 484;
				w = 644;
			}
			else {
				this.mesh_output = false;
			}
		}
		if (h*w != PCDheader.points){
			this.mesh_output = false;
		}
		
		if (this.mesh_output){
			var DATA_STRIDE = 3;
			var i = 0;
			for (var y = 0; y < h-1 ; y++){
				for ( var x = 0; x < w-1; x++, i += DATA_STRIDE ){
				var rightIndex = i + DATA_STRIDE;
				var downIndex = i + w * DATA_STRIDE;
				var downRightIndex = i + DATA_STRIDE + w * DATA_STRIDE;
				var currZ      = position[i + 2];
				var rightZ     = position[rightIndex + 2];
				var downZ      = position[downIndex + 2];
				var downRightZ = position[downRightIndex + 2];


				var upperLeftValid = ((Math.abs(currZ - rightZ) <= this.triangle_thresh) &&
									  (Math.abs(rightZ - downZ) <= this.triangle_thresh) &&
									  (Math.abs(downZ - currZ) <= this.triangle_thresh));
				if (upperLeftValid){
						indices.push( downIndex / DATA_STRIDE, rightIndex / DATA_STRIDE, i / DATA_STRIDE  );
					}
					var bottomRightValid = ((Math.abs(downZ - rightZ) <= this.triangle_thresh) &&
											(Math.abs(rightZ - downRightZ) <= this.triangle_thresh) &&
											(Math.abs(downRightZ - downZ) <= this.triangle_thresh));
					if (bottomRightValid){
						indices.push( downIndex / DATA_STRIDE, downRightIndex / DATA_STRIDE , rightIndex / DATA_STRIDE );
					}
					
				}
				i += DATA_STRIDE;
			}
			
			if ( indices.length > 0 ) {
				geometry.setIndex( indices );
			}
			geometry.computeVertexNormals();
			// build material

			var material = new THREE.MeshStandardMaterial( { color: 0xffffff, flatShading: false } );
			//var material = new THREE.MeshBasicMaterial( { color: 0xffffff } );

			if ( color.length > 0 ) {

				material.vertexColors = true;

			} else {

				material.color.setHex( Math.random() * 0xffffff );

			}

			// build mesh

			var mesh = new THREE.Mesh( geometry, material );
			mesh.castShadow = false;
			mesh.receiveShadow = false;
		}
		else {
			// build material

			var material = new THREE.PointsMaterial( { size: 1 } );

			if ( color.length > 0 ) {

				material.vertexColors = true;

			} else {

				material.color.setHex( Math.random() * 0xffffff );

			}

			// build mesh

			var mesh = new THREE.Points( geometry, material );
		}

		
		var name = url.split( '' ).reverse().join( '' );
		name = /([^\/]*)/.exec( name );
		name = name[ 1 ].split( '' ).reverse().join( '' );
		mesh.name = name;

		return mesh;

	}

};

export { PCDLoader };