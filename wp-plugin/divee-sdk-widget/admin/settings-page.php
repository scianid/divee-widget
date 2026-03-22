<?php
/**
 * Admin settings page
 *
 * @package DiveeSdkWpPlugin
 */

defined( 'ABSPATH' ) || exit;

/**
 * Register admin menu
 */
function divee_sdk_wp_register_admin_menu() {
	add_options_page(
		'Divee SDK Settings',
		'Divee SDK',
		'manage_options',
		'divee-sdk-wp-settings',
		'divee_sdk_wp_render_settings_page'
	);
}

/**
 * Register settings and fields
 */
function divee_sdk_wp_register_settings() {
	register_setting(
		'divee_sdk_wp_settings_group',
		'divee_sdk_wp_project_id',
		array(
			'sanitize_callback' => 'divee_sdk_wp_sanitize_project_id',
			'default'           => '',
		)
	);

	register_setting(
		'divee_sdk_wp_settings_group',
		'divee_sdk_wp_post_types',
		array(
			'sanitize_callback' => 'divee_sdk_wp_validate_post_types',
			'default'           => array( 'post', 'page' ),
		)
	);

	register_setting(
		'divee_sdk_wp_settings_group',
		'divee_sdk_wp_placement_mode',
		array(
			'sanitize_callback' => 'divee_sdk_wp_sanitize_placement_mode',
			'default'           => 'auto_bottom',
		)
	);

	// Add settings sections
	add_settings_section(
		'divee_sdk_wp_main_section',
		'Configuration',
		'divee_sdk_wp_render_main_section',
		'divee_sdk_wp_settings'
	);

	// Add settings fields
	add_settings_field(
		'divee_sdk_wp_project_id',
		'Project ID',
		'divee_sdk_wp_render_project_id_field',
		'divee_sdk_wp_settings',
		'divee_sdk_wp_main_section'
	);

	add_settings_field(
		'divee_sdk_wp_post_types',
		'Display on Post Types',
		'divee_sdk_wp_render_post_types_field',
		'divee_sdk_wp_settings',
		'divee_sdk_wp_main_section'
	);

	add_settings_field(
		'divee_sdk_wp_placement_mode',
		'Placement in Post',
		'divee_sdk_wp_render_placement_mode_field',
		'divee_sdk_wp_settings',
		'divee_sdk_wp_main_section'
	);
}

/**
 * Render settings page
 */
function divee_sdk_wp_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( 'Unauthorized' );
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Divee SDK Widget Settings', 'divee-sdk-widget' ); ?></h1>

		<div style="max-width: 600px;">
			<form method="post" action="options.php">
				<?php settings_fields( 'divee_sdk_wp_settings_group' ); ?>
				<?php do_settings_sections( 'divee_sdk_wp_settings' ); ?>
				<?php submit_button(); ?>
			</form>
		</div>

		<div style="margin-top: 30px; background: #f5f5f5; padding: 20px; border-radius: 5px; max-width: 600px;">
			<h3><?php esc_html_e( 'How to get started:', 'divee-sdk-widget' ); ?></h3>
			<ol>
				<li>
					<?php
					printf(
						/* translators: %s: link to divee.ai */
						wp_kses( __( 'Create an account at <a href="%s" target="_blank" rel="noopener noreferrer">divee.ai</a>', 'divee-sdk-widget' ), array( 'a' => array( 'href' => array(), 'target' => array(), 'rel' => array() ) ) ),
						'https://divee.ai'
					);
					?>
				</li>
				<li><?php esc_html_e( 'In your Divee dashboard, go to the Account section and set up your account.', 'divee-sdk-widget' ); ?></li>
				<li><?php esc_html_e( 'Go to the Inventory section and create a new widget.', 'divee-sdk-widget' ); ?></li>
				<li><?php esc_html_e( 'Copy the Project ID from your new widget and paste it in the field above.', 'divee-sdk-widget' ); ?></li>
				<li><?php esc_html_e( 'Select which post types should display the widget and choose a placement mode.', 'divee-sdk-widget' ); ?></li>
				<li><?php esc_html_e( 'Save settings. If using Shortcode mode, insert [divee_widget] inside post content where you want the widget to appear.', 'divee-sdk-widget' ); ?></li>
			</ol>
			<p>
				<strong><?php esc_html_e( 'Disable on specific posts:', 'divee-sdk-widget' ); ?></strong><br />
				<?php esc_html_e( 'You can disable the widget on individual posts using the "Disable Divee Widget" checkbox in the post editor.', 'divee-sdk-widget' ); ?>
			</p>
		</div>
	</div>
	<?php
}

/**
 * Render main section description
 */
function divee_sdk_wp_render_main_section() {
	echo wp_kses_post( '<p>' . __( 'Configure the Divee SDK widget settings for your WordPress site.', 'divee-sdk-widget' ) . '</p>' );
}

/**
 * Render project ID field
 */
function divee_sdk_wp_render_project_id_field() {
	$project_id = get_option( 'divee_sdk_wp_project_id' );
	?>
	<input 
		type="text" 
		name="divee_sdk_wp_project_id" 
		value="<?php echo esc_attr( $project_id ); ?>" 
		style="width: 100%; max-width: 400px;"
		placeholder="Enter your Divee Project ID"
		required
	/>
	<p class="description"><?php esc_html_e( 'Get your Project ID from the Divee Dashboard', 'divee-sdk-widget' ); ?></p>
	<?php
}

/**
 * Render post types field
 */
function divee_sdk_wp_render_post_types_field() {
	$enabled_types = divee_sdk_wp_get_enabled_post_types();
	$all_types     = divee_sdk_wp_get_all_post_types();
	?>
	<fieldset style="margin: 10px 0;">
		<?php foreach ( $all_types as $post_type ) : ?>
			<?php if ( $post_type->public ) : ?>
				<label style="display: block; margin-bottom: 8px;">
					<input 
						type="checkbox" 
						name="divee_sdk_wp_post_types[]" 
						value="<?php echo esc_attr( $post_type->name ); ?>"
						<?php checked( in_array( $post_type->name, $enabled_types, true ) ); ?>
					/>
					<?php echo esc_html( $post_type->label ); ?>
				</label>
			<?php endif; ?>
		<?php endforeach; ?>
	</fieldset>
	<p class="description"><?php esc_html_e( 'The widget will appear on selected post types', 'divee-sdk-widget' ); ?></p>
	<?php
}

/**
 * Render placement mode field
 */
function divee_sdk_wp_render_placement_mode_field() {
	$mode = divee_sdk_wp_get_placement_mode();
	?>
	<select name="divee_sdk_wp_placement_mode" style="min-width: 280px;">
		<option value="auto_bottom" <?php selected( $mode, 'auto_bottom' ); ?>><?php esc_html_e( 'Automatic: Bottom of post', 'divee-sdk-widget' ); ?></option>
		<option value="auto_top" <?php selected( $mode, 'auto_top' ); ?>><?php esc_html_e( 'Automatic: Top of post', 'divee-sdk-widget' ); ?></option>
		<option value="shortcode" <?php selected( $mode, 'shortcode' ); ?>><?php esc_html_e( 'Manual: Use [divee_widget] shortcode', 'divee-sdk-widget' ); ?></option>
	</select>
	<p class="description"><?php esc_html_e( 'Use shortcode mode for exact placement inside article content.', 'divee-sdk-widget' ); ?></p>
	<?php
}

/**
 * Add post meta box for per-post disable
 */
function divee_sdk_wp_add_post_meta_box() {
	$post_types = divee_sdk_wp_get_enabled_post_types();
	add_meta_box(
		'divee_sdk_wp_disable_meta_box',
		'Divee Widget',
		'divee_sdk_wp_render_post_meta_box',
		$post_types,
		'side',
		'default'
	);
}
add_action( 'add_meta_boxes', 'divee_sdk_wp_add_post_meta_box' );

/**
 * Render post meta box
 */
function divee_sdk_wp_render_post_meta_box( $post ) {
	wp_nonce_field( 'divee_sdk_wp_save_disable', 'divee_sdk_wp_nonce' );
	$disabled = get_post_meta( $post->ID, '_divee_sdk_wp_disable', true );
	?>
	<label>
		<input 
			type="checkbox" 
			name="divee_sdk_wp_disable" 
			value="1" 
			<?php checked( $disabled, 1 ); ?>
		/>
		<?php esc_html_e( 'Disable Divee Widget on this post', 'divee-sdk-widget' ); ?>
	</label>
	<?php
}

/**
 * Save post meta
 */
function divee_sdk_wp_save_post_meta( $post_id ) {
	if ( ! isset( $_POST['divee_sdk_wp_nonce'] ) || ! wp_verify_nonce( $_POST['divee_sdk_wp_nonce'], 'divee_sdk_wp_save_disable' ) ) {
		return;
	}

	if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
		return;
	}

	if ( ! current_user_can( 'edit_posts' ) ) {
		return;
	}

	if ( isset( $_POST['divee_sdk_wp_disable'] ) ) {
		update_post_meta( $post_id, '_divee_sdk_wp_disable', 1 );
	} else {
		delete_post_meta( $post_id, '_divee_sdk_wp_disable' );
	}
}
add_action( 'save_post', 'divee_sdk_wp_save_post_meta' );
